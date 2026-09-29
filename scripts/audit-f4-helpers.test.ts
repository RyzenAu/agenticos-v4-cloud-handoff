// AUDIT F4 (28 Sep): the new helpers S2 added for F1 and F5, and the rules replies they drive. SYNTHETIC.
// (scripts/audit-f4-safety.test.ts holds the regression cases that fail on f334ab7.)
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmationReply } from "../src/lib/jarvis-control";
import { moneyOrder, readOnlyMoneyQuestion } from "./jarvis-execution/spoken-money";
import { CANCELLED_LINE, confirmAnswer, freeVoice, REASK_LINE } from "./free-voice";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
  }
});

describe("confirmationReply", () => {
  test.each([
    ["yes", "yes"], ["okay, open notepad instead", "new-request"], ["sure, but first open Spotify", "new-request"],
    ["send it to Mehroz on WhatsApp", "new-request"], ["no, send it later", "no"], ["okay, cancel it", "no"], ["okay wait", "unclear"],
    ["sure, but", "unclear"], ["yes?", "unclear"], ["haan ji", "unclear"], ["", "unclear"],
    ["forget it", "no"], ["save it", "new-request"], ["okay thanks", "unclear"], ["absolutely not", "no"], ["Yes. Thank you.", "yes"],
  ])("%p → %p", (text, want) => expect(confirmationReply(text)).toBe(want as never));
});

describe("moneyOrder: detection only (S2d: nothing is refused because of it), read-only finance isn't an order", () => {
  test.each([
    ["pay the Telstra bill", /don't pay/], ["transfer $500 to Mehroz", /bank transfers/], ["buy 10 shares of Apple", /trades/],
    ["buy 1 bitcoin", /crypto/], ["place a bet on the footy", /betting/], ["open netbank", /bank, broker/], ["open commbank.com.au", /bank, broker/],
    ["what's my balance, then pay the Telstra bill", /don't pay/], ["search YouTube for bitcoin and buy some", /crypto/],
    ["upgrade my OpenRouter plan", /don't pay/], ["open stripe and issue a refund", /don't pay/], ["yes pay it", /don't pay/],
    ["how do I pay the Telstra bill? just do it for me", /don't pay/], ["open the Stripe dashboard", /bank, broker/], ["log in to NetBank", /bank, broker/],
  ])("%p orders a money move (routing only)", (text) => expect(moneyOrder(text as string)).toBe(true));
  test.each([
    "what's my bank balance", "what did I spend this month", "who owes me money", "when's my next payout", "how do I transfer money to Mehroz",
    "is it worth buying bitcoin", "search YouTube for how to pay off debt", "remember that the Telstra bill is due Friday",
    "open my NAB statement PDF from Downloads", "log the $825 deposit in the CRM", "add the A$699 package to the proposal", "pay attention to this",
    "subscribe to the channel", "open Notepad", "",
    "NAB transactions last week", "show me my NAB transactions from last week", "import the NAB CSV", "check my Stripe payouts",
    "transfer the files to D drive", "upgrade Windows",
  ])("%p is not a money order", (text) => expect(moneyOrder(text)).toBe(false));
  test("a finance question is read-only unless a later clause acts", () => {
    expect(readOnlyMoneyQuestion("what's my bank balance")).toBe(true);
    expect(readOnlyMoneyQuestion("what's my bank balance and then transfer $50 to Sam")).toBe(false);
  });
});

describe("the voice turn's replies to a pending question", () => {
  const offline = () => {
    const d = mkdtempSync(join(tmpdir(), "s2-helpers-"));
    dirs.push(d);
    const calls: string[] = [];
    const voice = freeVoice(d, {
      key: (name: string) => (name === "GROQ_API_KEY" ? "synthetic" : ""),
      fetch: (async (url: string) => (calls.push(String(url)), new Response(JSON.stringify({ choices: [{ message: { content: "brain" } }] }), { status: 200 }))) as typeof fetch,
    });
    return { voice, calls };
  };
  const screenQ = [
    { role: "user", content: "submit the contact form" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "screen_act", arguments: '{"goal":"submit the contact form"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "[confirm] Shall I press Submit?" },
    { role: "assistant", content: "Shall I press Submit?" },
  ];
  const controlQ = [
    { role: "user", content: "email the proposal to Mehroz" },
    { role: "assistant", content: null, tool_calls: [{ id: "k1", type: "function", function: { name: "control_pc", arguments: '{"task":"email the proposal to Mehroz"}' } }] },
    { role: "tool", tool_call_id: "k1", content: "CONFIRMATION REQUIRED. Nothing has been done yet. Read this action back…" },
    { role: "assistant", content: "Shall I email the proposal to Mehroz?" },
  ];
  test("a no is answered by rules: nothing pressed, no model call", async () => {
    for (const q of [screenQ, controlQ]) {
      const { voice, calls } = offline();
      expect(await voice.handle("/voice/free/turn", { messages: [...q, { role: "user", content: "no, send it later" }] })).toEqual({ content: CANCELLED_LINE, model: "rules" });
      expect(calls).toEqual([]);
    }
  });
  test("an unclear reply is asked again; a clear yes after the re-ask still presses the one button", async () => {
    const { voice, calls } = offline();
    const again: any = await voice.handle("/voice/free/turn", { messages: [...screenQ, { role: "user", content: "okay wait" }] });
    expect(again.model).toBe("rules");
    expect(again.content).toStartWith(REASK_LINE);
    const yes: any = await voice.handle("/voice/free/turn", { messages: [...screenQ, { role: "user", content: "okay wait" }, { role: "assistant", content: again.content }, { role: "user", content: "yes" }] });
    expect(JSON.parse(yes.tool_calls[0].function.arguments)).toEqual({ goal: "submit the contact form", confirmed: true });
    expect(calls).toEqual([]);
  });
  test("a new request drops the question and is routed as a new turn (never confirmed)", () => {
    expect(confirmAnswer([...screenQ, { role: "user", content: "okay, open notepad instead" }] as never)).toMatchObject({ reply: "new-request", call: null });
    expect(confirmAnswer([{ role: "user", content: "yes" }] as never)).toBeNull();
  });
  test("a control_pc yes is left to the brain's confirmed re-send (the gate checks the yes again)", () => {
    expect(confirmAnswer([...controlQ, { role: "user", content: "yes" }] as never)).toMatchObject({ reply: "yes", surface: "control", call: null });
  });
});

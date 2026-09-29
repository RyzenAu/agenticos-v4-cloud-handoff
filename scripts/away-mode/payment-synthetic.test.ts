// The synthetic away.payment suite (owner-authorised 28 Sep 2026: controlled tests, recording fakes only; live
// away payments stay OFF). 75 scenarios through the real away runner and real screen-hands: approvable kinds,
// gift cards, vouchers, buy-now-pay-later, never kinds, person-to-person, confusable payees, hosts, binding,
// replies, amount caps, the request's source, and the five REVIEW-SAFETY-R3 findings. Each scenario states the
// outcome TODAY (asserted here) and the outcome under PAYMENT-POLICY-PROPOSAL.md (asserted once he approves it).
import { describe, expect, test, setDefaultTimeout } from "bun:test";
// (Each case drives the real screen or away loop several times; a loaded machine can take over 5 s.)
setDefaultTimeout(30_000);
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { createScreenHands, parseScreenRequest, type Hands } from "../screen-hands/index";
import { resolveFlags } from "../screen-hands/flags";
import { el, runScenario, SCENARIOS } from "./payment-synthetic.fixture";

describe("synthetic away.payment scenarios (today's behaviour)", () => {
  test("the matrix covers every group the owner authorised", () => {
    const groups = new Set(SCENARIOS.map((s) => s.group));
    for (const g of ["approvable", "gift-card", "voucher", "bnpl", "never", "p2p", "payee", "host", "binding", "reply", "cap", "r3", "source"]) expect(groups.has(g as never)).toBe(true);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(75);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });
  test.each(SCENARIOS.map((s) => [s.id, s.what, s] as const))("%s %s", async (_id, _what, s) => {
    const r = await runScenario(s);
    expect({ id: s.id, outcome: r.outcome }).toEqual({ id: s.id, outcome: s.now });
    // Never: a press without his code, a second press, typed card data, or a money task sent to Hermes.
    expect(r.outcome).not.toBe("PRESSED-WITHOUT-CODE");
    expect(r.outcome).not.toBe("pressed-twice");
    expect(r.typed).toEqual([]);
    expect(r.hermes).toEqual([]);
    if (r.outcome === "paid") {
      expect(r.presses).toHaveLength(1);
      expect(r.receipts).toEqual([expect.objectContaining({ amount: r.pendingPayment?.amount, outcome: "confirmed" })]);
    } else {
      expect(r.presses).toEqual([]);
      expect(r.receipts).toEqual([]);
    }
  }, 30_000);
});

describe("R3 finding (1) on the attended screen path: a money button is never pressed, question or not, code or not", () => {
  const liveFlags = () => resolveFlags({}, { recheck: true, denylist: true, jevIrreversible: true, refs: true, jevStep: true, formFill: true, replay: true });
  test.each(["Pay", "Place order", "Make payment", "Stake", "Mint", "Buy now", "Send gift", "Top up"])("%p after his spoken yes: refused, nothing pressed", async (label) => {
    const log: string[] = [];
    const elements = [el("Edit", "Address and search bar", { value: "https://www.telstra.com.au/my-account/bills/pay" }), el("Text", "Amount due A$123.45"), el("Button", label)];
    const win = () => ({ handle: 7, process: "chrome", cls: "Chrome_WidgetWin_1", title: "Your bill - Telstra - Google Chrome" });
    const hands: Hands = {
      foreground: async () => win(), windows: async () => [win()], focus: async () => true,
      snapshot: async () => ({ window: { x: 0, y: 0, w: 1400, h: 800 }, elements, focused: null, browser: true }),
      focused: async () => null, at: async () => null, click: async () => void log.push("click"), press: async (_h, e) => (log.push(`press ${e.name}`), "uia"),
      type: async () => undefined, keys: async () => undefined, wheel: async () => undefined, capture: async () => null,
    };
    const ledger = new SpokenConfirmationLedger();
    const screen = createScreenHands({ key: () => "", hands, flags: liveFlags, audit: null, jarvisChrome: null, spoken: ledger });
    const first = await screen.act(parseScreenRequest({ goal: `click ${label}` }), new AbortController().signal);
    expect(first.refused).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const yes = ledger.record("yes")!;
    const second = await screen.act(parseScreenRequest({ goal: `click ${label}`, confirm: label, spokenYes: yes.id }), new AbortController().signal);
    expect(second.refused).toBe(true);
    expect(log).toEqual([]);
  });
});

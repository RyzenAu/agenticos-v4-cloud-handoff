// Desk payments (P1): the service through the REAL browser hands over a FAKE Jarvis Chrome (a CDP stub). SYNTHETIC: no
// real browser, bank, card or payment; every host, name and number is made up; receipts go to an array.
import { describe, expect, test } from "bun:test";
import type { PaymentReceipt } from "../away-mode/store";
import { createAgentBrowserHands } from "../j2/agent-browser";
import type { Principal } from "../identity/principal";
import { bankReviewPage, billPage, fakeChrome, homePage, isDeskPressCall, loginPage, type FakePage } from "./fake-bank";
import { deskOpenVerdict, deskVerdict } from "./policy";
import { createDeskPayments } from "./service";

const YES = { ok: true } as const;
const CTX = { desk: YES, source: "voice" as const };
const NOT_AT_DESK = { desk: { ok: false, why: "not-at-pc" } as const, source: "voice" as const };

function rig(pages: Record<string, FakePage>, opts: { away?: boolean | null; tab?: string; receiptsFail?: boolean; ttlMs?: number; heard?: boolean; presence?: { locked: boolean | null; idleMs: number | null }; pressTimeoutMs?: number } = {}) {
  const chrome = fakeChrome(pages);
  if (opts.tab) chrome.world.go(opts.tab);
  const hands = createAgentBrowserHands({ run: chrome.run, port: 9222 });
  const receipts: PaymentReceipt[] = [];
  let t = Date.UTC(2026, 8, 29, 10);
  let away: boolean | null = opts.away ?? false;
  const svc = createDeskPayments({
    hands: async () => hands,
    receipts: { write: (e) => (opts.receiptsFail ? false : (receipts.push(e), true)) },
    awayOn: () => away, requireHeard: opts.heard === true, presence: () => opts.presence ?? null, pressTimeoutMs: opts.pressTimeoutMs,
    now: () => t,
    sleep: async () => undefined,
    settleMs: 0,
    afterPressMs: 0,
    present: async () => null,
    ttlMs: opts.ttlMs,
  });
  return { chrome, hands, receipts, svc, advance: (ms: number) => void (t += ms), setAway: (v: boolean | null) => void (away = v) };
}
const BILL = "https://originenergy.com.au/pay";
const withBill = (o: Parameters<typeof billPage>[0] = {}) => rig({ [BILL]: billPage(o), "https://originenergy.com.au/": homePage() }, { tab: BILL });
const owner = (over: Partial<Principal> = {}): Principal => ({ personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sk1.abcdefghij", displayName: "Usman", deviceId: "hub", ...over });
/** Ask for the Origin bill and return the payment id. */
async function asked(r: ReturnType<typeof withBill>, words = "pay the Origin Energy bill") {
  const out = await r.svc.request(words, CTX);
  expect(out.ok).toBe(true);
  return out.pending!.id;
}

describe("desk verdict: who is at the desk", () => {
  test("the owner's live session at this PC, away off, is the desk", () => {
    expect(deskVerdict({ principal: owner(), awayOn: false })).toEqual({ ok: true });
  });
  test("everything else is not the desk", () => {
    expect(deskVerdict({ principal: owner(), awayOn: true })).toEqual({ ok: false, why: "away-on" });
    expect(deskVerdict({ principal: owner(), awayOn: null })).toEqual({ ok: false, why: "away-unknown" });
    expect(deskVerdict({ principal: owner({ actor: "process", sessionId: undefined }), awayOn: false })).toEqual({ ok: false, why: "no-session" });
    expect(deskVerdict({ principal: owner({ sessionId: "x" }), awayOn: false }).ok).toBe(false);
    expect(deskVerdict({ principal: owner({ via: "telegram-owner" }), awayOn: false })).toEqual({ ok: false, why: "not-at-pc" });
    expect(deskVerdict({ principal: owner({ via: "tailnet-person" }), awayOn: false })).toEqual({ ok: false, why: "not-at-pc" });
    expect(deskVerdict({ principal: owner({ via: "paired-session" }), awayOn: false })).toEqual({ ok: false, why: "not-at-pc" });
    expect(deskVerdict({ principal: owner({ via: "companion", actor: "process" }), awayOn: false })).toEqual({ ok: false, why: "not-at-pc" });
    expect(deskVerdict({ principal: owner({ personId: "mehroz" }), awayOn: false })).toEqual({ ok: false, why: "not-owner" });
    expect(deskVerdict({ principal: null, awayOn: false })).toEqual({ ok: false, why: "not-at-pc" });
  });
  test("the service reads away mode NOW, and an unreadable away state is not the desk", () => {
    const r = withBill();
    expect(r.svc.verdict(owner())).toEqual({ ok: true });
    r.setAway(true);
    expect(r.svc.verdict(owner())).toEqual({ ok: false, why: "away-on" });
    r.setAway(null);
    expect(r.svc.verdict(owner())).toEqual({ ok: false, why: "away-unknown" });
  });
});

describe("a desk payment: request → confirm card → one press → receipt", () => {
  test("a request reads the page and creates ONE pending payment; nothing is pressed", async () => {
    const r = withBill();
    const out = await r.svc.request("pay the Origin Energy bill", CTX);
    expect(out.ok).toBe(true);
    expect(out.said).toBe("Pay A$120 to Origin Energy on originenergy.com.au? Say yes to go.");
    expect(out.pending).toMatchObject({ payee: "Origin Energy", amount: "120.00", host: "originenergy.com.au", button: "Pay A$120.00", what: "Bill" });
    expect(r.chrome.clicked).toEqual([]);
    expect(r.svc.status({ desk: YES }).pending).toHaveLength(1);
    expect(r.receipts).toEqual([]);
  });
  test("Confirm (his click) presses exactly once, writes a receipt before and after, and a second confirm does nothing", async () => {
    const r = withBill();
    const id = await asked(r);
    const done = await r.svc.confirm(id, { how: "card-click" }, CTX);
    expect(done.ok).toBe(true);
    expect(done.said).toMatch(/^Paid A\$120\.00 to Origin Energy, reference OE-88231907\. Receipt saved\.$/);
    expect(r.chrome.clicked).toEqual(["Pay A$120.00"]);
    expect(r.receipts.map((x) => x.outcome)).toEqual(["pressing", "confirmed"]);
    expect(r.receipts[1]).toMatchObject({ mode: "desk", how: "card-click", payee: "Origin Energy", amount: "120.00", currency: "AUD", host: "originenergy.com.au", what: "Bill", reference: "OE-88231907", source: "voice" });
    const again = await r.svc.confirm(id, { how: "card-click" }, CTX);
    expect(again.ok).toBe(false);
    expect(again.said).toMatch(/already dealt with/);
    expect(r.chrome.clicked).toHaveLength(1);
    expect(r.svc.status({ desk: YES }).recent[0]).toMatchObject({ state: "done", payee: "Origin Energy" });
  });
  test("what he said must be what the page shows: a different amount or payee sets nothing up", async () => {
    const r = withBill();
    const amount = await r.svc.request("pay the Origin Energy bill for 90 dollars", CTX);
    expect(amount).toMatchObject({ ok: false, said: "That page says A$120, not $90. I haven't set up a payment." });
    const other = rig({ [BILL]: billPage({ payee: "Someone Else Pty Ltd" }) }, { tab: BILL });
    const payee = await other.svc.request("pay the Origin Energy bill", CTX);
    expect(payee.ok).toBe(false);
    expect(payee.said).toBe("That page pays Someone Else Pty Ltd, not Origin Energy. I haven't set up a payment.");
    expect(r.svc.status({ desk: YES }).pending).toEqual([]);
    expect(other.svc.status({ desk: YES }).pending).toEqual([]);
  });
  test("the amount he named is confirmed against the page: 120 dollars matches A$120.00", async () => {
    const r = withBill();
    const out = await r.svc.request("pay the Origin Energy bill for 120 dollars", CTX);
    expect(out.ok).toBe(true);
  });
  test("'pay the Telstra bill' with another payee's page in front opens Telstra's site; it never pays the page in front", async () => {
    const r = withBill();
    const out = await r.svc.request("pay the Telstra bill", CTX);
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/^Opened telstra\.com\.au\./);
    expect(r.chrome.log).toContain("tab new https://telstra.com.au/");
    expect(r.chrome.clicked).toEqual([]);
    expect(r.svc.status({ desk: YES }).pending).toEqual([]);
  });
  test("a shortener, a raw IP or a look-alike host is never opened for a payment", async () => {
    const r = rig({});
    for (const words of ["pay bit.ly/3payNow", "pay 203.0.113.10 for the bill", "pay the telstra-bill.xn--pypal-4ve.com invoice"]) {
      const out = await r.svc.request(words, CTX);
      expect(out.ok).toBe(false);
    }
    expect(r.chrome.log.some((l) => l.startsWith("tab new"))).toBe(false);
  });
  test("'pay this' twice is one card, not two", async () => {
    const r = withBill();
    const first = await r.svc.request("pay this", CTX);
    const second = await r.svc.request("pay it", CTX);
    expect(second.said).toBe(`Still waiting: ${first.said}`);
    expect(r.svc.status({ desk: YES }).pending).toHaveLength(1);
  });
  test("a bank's review step with a bare Confirm works, and shows exactly what will be pressed", async () => {
    const u = "https://netbank.commbank.com.au/pay";
    const r = rig({ [u]: bankReviewPage() }, { tab: u });
    const out = await r.svc.request("pay the Telstra bill", CTX);
    expect(out.ok).toBe(true);
    expect(out.pending).toMatchObject({ payee: "Telstra", amount: "89.90", host: "netbank.commbank.com.au", button: "Confirm" });
    expect(out.said).toContain("(you named telstra.com.au)");
    const done = await r.svc.confirm(out.pending!.id, { how: "card-click" }, CTX);
    expect(done.ok).toBe(true);
    expect(r.chrome.clicked).toEqual(["Confirm"]);
  });
});

describe("expiry and cancel", () => {
  test("a payment nobody confirmed in 2 minutes is gone and pays nothing", async () => {
    const r = withBill();
    const id = await asked(r);
    r.advance(2 * 60 * 1000 - 1);
    expect(r.svc.status({ desk: YES }).pending).toHaveLength(1);
    r.advance(2);
    expect(r.svc.status({ desk: YES }).pending).toEqual([]);
    const late = await r.svc.confirm(id, { how: "card-click" }, CTX);
    expect(late.ok).toBe(false);
    expect(late.said).toMatch(/timed out/);
    expect(r.chrome.clicked).toEqual([]);
    expect(r.receipts).toEqual([]);
  });
  test("cancel drops it; a confirm after that pays nothing", async () => {
    const r = withBill();
    const id = await asked(r);
    expect(r.svc.cancel(id)).toMatchObject({ ok: true, said: "Cancelled. Nothing was paid." });
    const after = await r.svc.confirm(id, { how: "card-click" }, CTX);
    expect(after.ok).toBe(false);
    expect(r.chrome.clicked).toEqual([]);
    expect(r.svc.cancel("all")).toMatchObject({ ok: false, said: "Nothing was waiting." });
  });
});

describe("the press re-reads the page: anything that changed stops it, and says what", () => {
  const stopped = async (change: (r: ReturnType<typeof withBill>) => void | Promise<void>) => {
    const r = withBill();
    const id = await asked(r);
    await change(r);
    const done = await r.svc.confirm(id, { how: "card-click" }, CTX);
    expect(done.ok).toBe(false);
    expect(r.chrome.clicked).toEqual([]);
    expect(r.receipts.map((x) => x.outcome)).toEqual(["stopped"]);
    return done.said;
  };
  test("the amount changed", async () => {
    const said = await stopped((r) => void (r.chrome.pages[BILL] = billPage({ amount: "A$130.00" })));
    expect(said).toContain("the amount is now A$130.00, not A$120.00");
    expect(said).toMatch(/Nothing was paid\.$/);
  });
  test("the amount changed but the button still says the old one", async () => {
    const said = await stopped((r) => void (r.chrome.pages[BILL] = { ...billPage({ amount: "A$130.00" }), controls: [{ role: "button", name: "Pay A$120.00" }] }));
    expect(said).toContain("The button's amount and the page's total don't agree");
  });
  test("the payee changed", async () => {
    const said = await stopped((r) => void (r.chrome.pages[BILL] = billPage({ payee: "Someone Else Pty Ltd" })));
    expect(said).toContain("it now pays Someone Else Pty Ltd, not Origin Energy");
  });
  test("the button changed", async () => {
    const said = await stopped((r) => void (r.chrome.pages[BILL] = billPage({ button: "Pay in full" })));
    expect(said).toContain(`the button is now "Pay in full", not "Pay A$120.00"`);
  });
  test("an order line appeared (an add-on)", async () => {
    const said = await stopped((r) => void (r.chrome.pages[BILL] = billPage({ extra: "Auto-renew add-on A$9.00 per month" })));
    expect(said).toContain("the order lines on the page changed");
  });
  test("a different tab is in front", async () => {
    const said = await stopped((r) => void r.chrome.run(["--session", "s", "--cdp", "9222", "tab", "new", "https://example.test/"]));
    expect(said).toContain("it's a different tab now");
  });
  test("the tab went to another site with the same page", async () => {
    const said = await stopped((r) => {
      r.chrome.pages["https://evil.example/pay"] = billPage();
      r.chrome.world.go("https://evil.example/pay");
    });
    expect(said).toContain("the site is now evil.example, not originenergy.com.au");
  });
  test("the pay button is gone", async () => {
    const said = await stopped((r) => void (r.chrome.pages[BILL] = homePage()));
    expect(said).toMatch(/pay button/);
  });
  test("the page turned into a login", async () => {
    const said = await stopped((r) => void (r.chrome.pages[BILL] = loginPage()));
    expect(said).toMatch(/password/);
  });
});

describe("the press itself: once, honestly, with an audit line first", () => {
  test("no receipt line, no payment: the press waits for the audit trail", async () => {
    const r = rig({ [BILL]: billPage() }, { tab: BILL, receiptsFail: true });
    const id = await asked(r as never);
    const done = await r.svc.confirm(id, { how: "card-click" }, CTX);
    expect(done.ok).toBe(false);
    expect(done.said).toMatch(/couldn't write the receipt line first, so nothing was paid/);
    expect(r.chrome.clicked).toEqual([]);
  });
  test("a page that shows no confirmation after the press is UNKNOWN, never pressed again", async () => {
    const page = billPage();
    page.onClick = () => undefined; // the site does nothing visible
    const r = rig({ [BILL]: page }, { tab: BILL });
    const id = await asked(r as never);
    const done = await r.svc.confirm(id, { how: "card-click" }, CTX);
    expect(done.ok).toBe(false);
    expect(done.said).toMatch(/pressed "Pay A\$120\.00" once for A\$120\.00 to Origin Energy, but I couldn't see a confirmation\. I won't press it again/);
    expect(r.receipts.map((x) => x.outcome)).toEqual(["pressing", "unknown"]);
    expect((await r.svc.confirm(id, { how: "card-click" }, CTX)).ok).toBe(false);
    expect(r.chrome.clicked).toHaveLength(1);
  });
  test("a click that errors is UNKNOWN too, and is not retried", async () => {
    const r = withBill();
    const id = await asked(r);
    const original = r.chrome.run;
    let failed = 0;
    const hands = createAgentBrowserHands({
      run: async (argv, t) => {
        if (isDeskPressCall(argv)) return (failed++, { code: 1, stdout: JSON.stringify({ success: false, data: null, error: "boom" }) + "\n", stderr: "" });
        return original(argv, t);
      },
      port: 9222,
    });
    const svc2 = createDeskPayments({ hands: async () => hands, receipts: { write: (e) => (r.receipts.push(e), true) }, awayOn: () => false, requireHeard: false, now: () => Date.UTC(2026, 8, 29, 10), sleep: async () => undefined, settleMs: 0, afterPressMs: 0 });
    const again = await svc2.request("pay the Origin Energy bill", CTX);
    const done = await svc2.confirm(again.pending!.id, { how: "card-click" }, CTX);
    expect(done.ok).toBe(false);
    expect(done.said).toMatch(/It may or may not have gone through/);
    expect(failed).toBe(1);
    expect(r.receipts.at(-1)?.outcome).toBe("unknown");
  });
  test("a made-up ConfirmedPress presses nothing (the hands need the store's)", async () => {
    const r = withBill();
    const hands = r.hands;
    const forged = { used: false, paymentId: "dp_x", how: "card-click", control: { element: "x", targetId: "T1", url: BILL, host: "originenergy.com.au" }, at: 0 };
    const out = await hands.pressBound(forged as never, "e2");
    expect(out.ok).toBe(false);
    expect(r.chrome.clicked).toEqual([]);
  });
});

describe("the page must be ready for a payment, and the card's fields are his", () => {
  const ask = (page: FakePage) => {
    const r = rig({ [BILL]: page }, { tab: BILL });
    return r.svc.request("pay the Origin Energy bill", CTX).then((out) => ({ out, r }));
  };
  test("a login is his: one line, no payment", async () => {
    const { out, r } = await ask(loginPage());
    expect(out.ok).toBe(false);
    expect(out.said).toBe("It's asking for your password; that's yours to type. Say pay this when you're through.");
    expect(r.svc.status({ desk: YES }).pending).toEqual([]);
  });
  test("empty card fields are his (Jarvis never types a card)", async () => {
    const { out } = await ask({ ...billPage(), fields: { cardPresent: true, cardEmpty: true } });
    expect(out.said).toBe("The card details are still empty; type them yourself, then say pay this.");
  });
  test("a code sent to him is his", async () => {
    const { out } = await ask({ ...billPage(), fields: { otpEmpty: true } });
    expect(out.said).toBe("It wants a code sent to you; type it yourself, then say pay this.");
  });
  test("a card in a secure frame can't be read, so pressing is his", async () => {
    const { out } = await ask({ ...billPage(), fields: { cardFrame: true } });
    expect(out.said).toMatch(/secure frame I can't read, so pressing Pay is yours this time/);
  });
  test("filled or autofilled card fields are fine", async () => {
    const { out } = await ask({ ...billPage(), fields: { cardPresent: true, cardEmpty: false } });
    expect(out.ok).toBe(true);
  });
  test("a page that has finished loading is waited for", async () => {
    const { out } = await ask({ ...billPage(), loading: 2 });
    expect(out.ok).toBe(true);
  });
  test("a page with no pay button yet: one line, and the site is opened when he named one", async () => {
    const r = rig({ "https://originenergy.com.au/": homePage() });
    const out = await r.svc.request("pay the Origin Energy bill", CTX);
    expect(out.ok).toBe(false);
    expect(out.said).toBe("Opened originenergy.com.au. I can't see a pay button on that page yet. Get to the payment step and say pay this.");
    expect(r.chrome.log).toContain("tab new https://originenergy.com.au/");
    expect(r.chrome.clicked).toEqual([]);
  });
  test("two different ways to pay is not one exact payment", async () => {
    const page: FakePage = { ...billPage(), controls: [{ role: "button", name: "Pay A$120.00" }, { role: "button", name: "Place order" }] };
    const { out } = await ask(page);
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/more than one way to pay/);
  });
  test("wallets and other methods are not the pay button", async () => {
    const page: FakePage = { ...billPage(), controls: [{ role: "button", name: "Pay with PayPal" }, { role: "button", name: "Apple Pay" }] };
    const { out } = await ask(page);
    expect(out.said).toMatch(/can't see a pay button/);
  });
  test("a button labelled two ways (an aria-label that hides a different name) is not pressed", async () => {
    const page: FakePage = { ...billPage(), controls: [{ role: "button", name: "Pay A$120.00", text: "Delete account", aria: "Pay A$120.00" }] };
    const { out } = await ask(page);
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/couldn't read everything the pay button is labelled/);
  });
  test("a look-alike button name (mixed script) is not a pay button", async () => {
    const page: FakePage = { ...billPage(), controls: [{ role: "button", name: "Рay A$120.00" }] }; // Cyrillic Р
    const { out } = await ask(page);
    expect(out.ok).toBe(false);
  });
  test("a page with two amounts and no total is not exact", async () => {
    const page: FakePage = { ...billPage(), text: "Pay your bill\nPaying: Origin Energy\nA$120.00 electricity\nA$45.00 gas\nCard ending 4242", controls: [{ role: "button", name: "Pay now" }] };
    const { out } = await ask(page);
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/more than one amount|can't read one exact amount|don't agree/);
  });
});

describe("never, even at the desk", () => {
  const cases: Array<[string, string, string]> = [
    ["a share trade", "buy 10 Tesla shares", "I don't make trades or investments; that's research only."],
    ["crypto", "buy some bitcoin", "I don't buy, sell or send crypto."],
    ["a bet", "put 50 on the Swans", "I don't place bets."],
    ["a card number in his words", "pay Sam with card number 4111 1111 1111 1111", "Type card numbers, codes and passwords yourself; I'll stop at the field."],
  ];
  test.each(cases)("%s: one short line, nothing opened, nothing set up", async (_n, words, line) => {
    const r = withBill();
    const out = await r.svc.request(words, CTX);
    expect(out).toMatchObject({ ok: false, said: line, refused: true });
    expect(r.chrome.log.some((l) => l.startsWith("tab new"))).toBe(false);
    expect(r.svc.status({ desk: YES }).pending).toEqual([]);
  });
  test("a broker, exchange or bookie page is refused even when his words were harmless", async () => {
    const trade: FakePage = { title: "Buy NVDA - Fake Broker", text: "Order type: Market order\nShares 10\nNVIDIA Corp (NVDA)\nTotal $1,200.00\nPaying: Fake Broker", controls: [{ role: "button", name: "Place order" }] };
    const crypto: FakePage = { title: "Checkout", text: "Paying: Fake Shop\nTotal $50.00\nBitcoin wallet address bc1qexample\nCrypto payment", controls: [{ role: "button", name: "Pay $50.00" }] };
    const bet: FakePage = { title: "Bet slip", text: "Bet slip\nOdds 2.10\nStake $20.00\nTotal $20.00\nPaying: Fake Bookie", controls: [{ role: "button", name: "Place bet" }] };
    for (const [page, line] of [[trade, "trades"], [crypto, "crypto"], [bet, "bets"]] as const) {
      const r = rig({ [BILL]: page }, { tab: BILL });
      const out = await r.svc.request("pay this", CTX);
      expect(out.ok).toBe(false);
      expect(out.said).toContain(line);
      expect(r.chrome.clicked).toEqual([]);
    }
  });
  test("a broker, exchange or bookie site never OPENS at the desk; a bank or payment site does", async () => {
    expect(deskOpenVerdict("https://www.commbank.com.au/")).toEqual({ ok: true });
    expect(deskOpenVerdict("https://www.paypal.com/")).toEqual({ ok: true });
    expect(deskOpenVerdict("https://dashboard.stripe.com/")).toEqual({ ok: true });
    expect(deskOpenVerdict("https://www.commsec.com.au/")).toMatchObject({ ok: false, said: "I don't make trades or investments; that's research only." });
    expect(deskOpenVerdict("https://www.binance.com/")).toMatchObject({ ok: false, said: "I don't buy, sell or send crypto." });
    expect(deskOpenVerdict("https://www.sportsbet.com.au/")).toMatchObject({ ok: false, said: "I don't place bets." });
    expect(deskOpenVerdict("https://bit.ly/3payNow")).toMatchObject({ ok: false });
    expect(deskOpenVerdict("http://203.0.113.10/netbank")).toMatchObject({ ok: false });
    expect(deskOpenVerdict("https://xn--nb-7kc.com.au/")).toMatchObject({ ok: false });
    expect(deskOpenVerdict("file:///C:/x.html")).toMatchObject({ ok: false });
    const r = withBill();
    expect((await r.hands.openDesk("https://www.commbank.com.au/")).ok).toBe(true);
    expect((await r.hands.openDesk("https://www.binance.com/")).ok).toBe(false);
    // The ordinary hands (everyone else, and away mode) still refuse a bank: unchanged.
    expect((await r.hands.open("https://www.commbank.com.au/")).ok).toBe(false);
  });
});

describe("not at the desk: nothing starts, confirms or opens", () => {
  test("a request from anyone else is one short line and touches nothing", async () => {
    const r = withBill();
    const out = await r.svc.request("pay the Origin Energy bill", NOT_AT_DESK);
    expect(out).toMatchObject({ ok: false, refused: true, said: "That's a payment, and I only make those with you at the PC. Nothing was done." });
    expect(r.chrome.log).toEqual([]);
  });
  test("a confirm from anyone else pays nothing even for a live payment", async () => {
    const r = withBill();
    const id = await asked(r);
    const out = await r.svc.confirm(id, { how: "card-click" }, NOT_AT_DESK);
    expect(out.ok).toBe(false);
    expect(r.chrome.clicked).toEqual([]);
    expect(r.svc.status({ desk: YES }).pending).toHaveLength(1);
  });
  test("the card's feed is empty unless it is the desk", async () => {
    const r = withBill();
    await asked(r);
    expect(r.svc.status({ desk: NOT_AT_DESK.desk })).toMatchObject({ desk: false, pending: [], recent: [] });
  });
  test("the turn rules do nothing when it isn't the desk", async () => {
    const r = withBill();
    expect(await r.svc.turn("pay the Origin Energy bill", { desk: false })).toBeNull();
    expect(await r.svc.turn("open my bank", { desk: false })).toBeNull();
    expect(await r.svc.turn("yes", { desk: false })).toBeNull();
  });
});

describe("the synthetic preview copy", () => {
  test("only a quiet copy started with DESK_PAY_SYNTHETIC=1 may exercise the desk payment routes", async () => {
    const { deskPaySyntheticAllowed } = await import("../preview-guard");
    const on = { AGENTIC_OS_NO_BACKGROUND: "1", DESK_PAY_SYNTHETIC: "1" } as NodeJS.ProcessEnv;
    expect(deskPaySyntheticAllowed("/__operator/desk-pay/confirm", on)).toBe(true);
    expect(deskPaySyntheticAllowed("/__operator/jarvis/skill", on)).toBe(true);
    expect(deskPaySyntheticAllowed("/__operator/away", on)).toBe(false);
    expect(deskPaySyntheticAllowed("/__operator/desk-pay/confirm", { AGENTIC_OS_NO_BACKGROUND: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(deskPaySyntheticAllowed("/__operator/desk-pay/confirm", { DESK_PAY_SYNTHETIC: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

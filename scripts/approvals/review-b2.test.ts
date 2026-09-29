// Regression tests for every repro in REVIEW-B2.md (28 Sep): one test per finding, named after it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlDispatchGate } from "../jarvis-execution/server-approval";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { jobsApprovalsRoute } from "../jobs/routes";
import { JobService } from "../jobs/service";
import { argsDigest, canonicalJson } from "./canonical";
import { refuseBeforeRequest } from "./policy";
import type { Principal } from "./principal";
import { hasRelayHeaders } from "../identity/principal";
import { ApprovalService } from "./service";

const usman: Principal = { personId: "usman", via: "loopback-owner" };
const usmanTg: Principal = { personId: "usman", via: "telegram-owner", actor: "human" };
/** Usman in his browser: B1 resolves a live session cookie as actor "human". */
const usmanUi: Principal = { personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sess-usman-0001" };
const bill = {
  taskId: "away-1",
  host: "my.commbank.com.au",
  payee: { id: "biller-1", name: "Origin Energy", saved: true },
  amount: { minor: 12000, currency: "AUD" },
  element: { label: "Pay bill", ref: "uia:pay" },
  category: "saved-payee",
};
const pay = (args: unknown) => refuseBeforeRequest({ action: "away.payment", args, origin: "principal" })?.code ?? "ok";
const refuse = (action: string, args: unknown) => refuseBeforeRequest({ action, args, origin: "principal" })?.code ?? "ok";

describe("B1: away.payment never funds trading, crypto or betting (shared institution table)", () => {
  test("saved payees named after a broker, exchange or bookmaker are refused", () => {
    const cases: [string, string][] = [
      ["CoinSpot", "crypto"], ["Sportsbet", "betting"], ["Ladbrokes", "betting"], ["CommSec", "trade"], ["Binance Australia", "crypto"],
      ["Swyftx", "crypto"], ["PointsBet", "betting"], ["CoinSpotAU", "crypto"], ["MyBinanceApp", "crypto"],
    ];
    for (const [name, code] of cases) expect({ name, code: pay({ ...bill, payee: { id: "p1", name, saved: true } }) }).toEqual({ name, code });
    expect(pay({ ...bill, payee: { id: "coinspot-bpay", name: "Deposit account", saved: true } })).toBe("crypto");
    expect(pay({ ...bill, element: { label: "Pay Sportsbet", ref: "x" } })).toBe("betting");
  });

  test("look-alike and compound hosts are refused", () => {
    expect(pay({ ...bill, host: "mystake.com" })).toBe("trade");
    expect(pay({ ...bill, host: "sportsbet-au.com" })).toBe("betting");
    expect(pay({ ...bill, host: "coinspot-login.net" })).toBe("crypto");
  });

  test("the currency is a real ISO 4217 code: XBT and friends are refused", () => {
    expect(pay({ ...bill, amount: { minor: 1, currency: "XBT" } })).toBe("crypto");
    expect(pay({ ...bill, amount: { minor: 1, currency: "XAU" } })).toBe("payment-out-of-scope");
    expect(pay({ ...bill, amount: { minor: 1, currency: "AUD" } })).toBe("ok");
    expect(pay({ ...bill, amount: { minor: 1, currency: "NZD" } })).toBe("ok");
  });

  test("the over-blocks are fixed: bond boards, 'Payment options' and a BPAY CRN are fine", () => {
    expect(pay({ ...bill, payee: { id: "p1", name: "Rental Bond Board", saved: true } })).toBe("ok");
    expect(pay({ ...bill, element: { label: "Payment options", ref: "x" } })).toBe("ok");
    expect(pay({ ...bill, payee: { id: "123456789012", name: "Origin", saved: true } })).toBe("ok");
    expect(pay({ ...bill, payee: { id: "p1", name: "Stakeholder Consulting", saved: true } })).toBe("ok");
    // ...but a card number is never a payee id, and nothing else may carry a long digit run.
    expect(pay({ ...bill, payee: { id: "4111111111111111", name: "Origin", saved: true } })).toBe("typed-credentials");
    expect(pay({ ...bill, element: { label: "Pay 4111.1111.1111.1111", ref: "x" } })).toBe("typed-credentials");
  });
});

describe("B4: top-ups are never approvable; the money scan covers every key and value with no silent cap", () => {
  test("provider.config.change and account.change can't top up, buy credits or upgrade a plan", () => {
    expect(refuse("provider.config.change", { change: "enable OpenRouter auto top-up of US$50 when the balance is under $5" })).toBe("money-not-approvable");
    expect(refuse("provider.config.change", { provider: "higgsfield", autoTopUp: { amountUsd: 500 } })).toBe("money-not-approvable");
    expect(refuse("provider.config.change", { provider: "openrouter", credits: 20 })).toBe("money-not-approvable");
    expect(refuse("account.change", { plan: "max" })).toBe("money-not-approvable");
    expect(refuse("account.change", { action: "upgrade to the Max plan" })).toBe("money-not-approvable");
    expect(refuse("provider.config.change", { provider: "openrouter", setting: "model", value: "deepseek/deepseek-chat" })).toBe("ok");
  });

  test("every registered action's args are screened (deploy with a payment note)", () => {
    expect(refuse("deploy", { note: "this will pay $20/mo" })).toBe("money-not-approvable");
    expect(refuse("deploy", { site: "muv-marketing", ref: "main" })).toBe("ok");
  });

  test("money nested 7 deep, after 205 padding strings, or in a KEY is still found", () => {
    let deep: unknown = { label: "Pay now $50" };
    for (let i = 0; i < 7; i++) deep = { x: deep };
    expect(refuse("screen.press", deep)).toBe("money-not-approvable");
    expect(refuse("screen.press", { pad: Array.from({ length: 205 }, (_, i) => `ok ${i}`), label: "Buy now" })).toBe("money-not-approvable");
    expect(refuse("screen.press", { "Pay now $50": true })).toBe("money-not-approvable");
  });

  test("args past the walk limits are refused (fail closed), never silently truncated", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 40; i++) deep = (deep.x = {}) as Record<string, unknown>;
    expect(refuse("coding.merge", root)).toBe("args-too-large");
    expect(refuse("coding.merge", { many: Array.from({ length: 6000 }, () => "x") })).toBe("args-too-large");
  });
});

describe("item 1: canonical digest collisions", () => {
  test("Dates, Maps, Sets and class instances are refused; a parsed __proto__ key is kept", () => {
    for (const v of [new Date(0), new Map(), new Set(), new (class A {})()]) expect(() => canonicalJson({ v })).toThrow();
    const parsed = JSON.parse('{"__proto__":{"amount":999}}');
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"amount":999}}');
    expect(argsDigest("x", parsed)).not.toBe(argsDigest("x", {}));
  });
});

describe("item 4: relay headers (one shared check: B1's hasRelayHeaders)", () => {
  test("proxied requests are recognised by the identity layer B2 now resolves through", () => {
    for (const h of ["via", "x-real-ip", "x-forwarded-for", "forwarded", "tailscale-user-login"]) expect(hasRelayHeaders({ headers: { [h]: "x" } })).toBe(true);
    expect(hasRelayHeaders({ headers: { host: "localhost:8081" } })).toBe(false);
  });
});

describe("R2 re-check: money refusal keys on money ACTIONS, not topic words (over-blocks)", () => {
  test("billing code, invoices and pricing copy are askable", () => {
    expect(refuse("coding.merge", { repoId: "agenticos", branch: "feat/stripe-billing", fromSha: "a".repeat(40) })).toBe("ok");
    expect(refuse("deploy", { site: "muv-marketing", note: "billing page copy fix" })).toBe("ok");
    expect(refuse("file.delete", { path: "D:/finance/billing-2026-09.pdf" })).toBe("ok");
    expect(refuse("memory.forget", { target: "billing address", planDigest: "p" })).toBe("ok");
    expect(refuse("message.send", { to: "client-7", subject: "Invoice INV-104", body: "Your invoice for A$1,373.90 incl. GST is attached. Please pay by 5 Oct." })).toBe("ok");
    expect(refuse("message.send", { to: "lead-3", body: "The Professional plan is A$1,099/month ex GST." })).toBe("ok");
    expect(refuse("content.publish", { page: "pricing", copy: "Premium A$1,999 / 1,800 min / A$0.70" })).toBe("ok");
  });

  test("money actions are still refused on every action", () => {
    expect(refuse("deploy", { note: "this will pay $20/mo" })).toBe("money-not-approvable");
    expect(refuse("coding.merge", { note: "buy 1000 credits" })).toBe("money-not-approvable");
    expect(refuse("message.send", { to: "x", action: "enable auto top-up" })).toBe("money-not-approvable");
    // Even in message copy, CHANGING billing is refused (it's what the message would do, not what it says).
    expect(refuse("message.send", { to: "support", body: "Please raise our credit limit to $500" })).toBe("money-not-approvable");
    // Press surfaces keep the full screen: a price on a label, a bank name, a money button.
    expect(refuse("screen.press", { window: "Checkout", button: "Pay A$1,099" })).toBe("money-not-approvable");
  });
});

describe("R2 re-check: provider.config.change is one allowlisted setting", () => {
  test("credit limits, auto-reload, plan switches and payments can't be expressed", () => {
    for (const args of [
      { change: "raise the OpenRouter credit limit to $100" },
      { change: "enable auto-reload" },
      { autoReload: { enabled: true } },
      { change: "switch Higgsfield to the Creator plan" },
      { change: "PayPal me $20 to bianca" },
      { change: "Revolut Mehroz 30" },
      { provider: "openrouter", setting: "creditLimit", value: 100 },
      { provider: "higgsfield", setting: "plan", value: "creator" },
      { provider: "higgsfield", setting: "model", value: "creator-plan-upgrade" },
      { provider: "openrouter", setting: "model", value: "auto-reload" },
      { provider: "openrouter", setting: "model", value: "x", extra: 1 },
      { provider: "openrouter", setting: "model", value: "creator-tier" },
      { provider: "openrouter", setting: "region", value: "billing" },
    ])
      expect({ args, code: refuse("provider.config.change", args) }).toEqual({ args, code: "money-not-approvable" });
  });

  test("ordinary settings are askable", () => {
    expect(refuse("provider.config.change", { provider: "openrouter", setting: "model", value: "deepseek/deepseek-chat" })).toBe("ok");
    expect(refuse("provider.config.change", { provider: "higgsfield", setting: "enabled", value: false })).toBe("ok");
    expect(refuse("provider.config.change", { provider: "groq", setting: "timeoutMs", value: 30000 })).toBe("ok");
    expect(refuse("provider.config.change", { provider: "openrouter", setting: "model", value: "claude-sonnet-4.6" })).toBe("ok");
  });

  test("account changes can't switch plans or raise limits either", () => {
    expect(refuse("account.change", { action: "switch to the Creator plan" })).toBe("money-not-approvable");
    expect(refuse("account.change", { action: "raise the credit limit" })).toBe("money-not-approvable");
    expect(refuse("account.change", { action: "rename the workspace to M&U" })).toBe("ok");
  });
});

describe("R2 re-check: payees by category plus evidence, not a bare brand word", () => {
  test("real businesses that share a word with a broker, exchange or bookmaker are payable", () => {
    for (const name of ["Kraken Rum Co", "Neds Barbershop", "Stake Dental", "Coinstar Laundromat", "Vanguard Plumbing", "Superhero Dental", "Spaceship Childcare", "Raiz Physio", "Coin Laundry Penrith", "Crypto Plumbing", "Sportsbet Rewards Club"])
      expect({ name, code: pay({ ...bill, payee: { id: "p1", name, saved: true } }) }).toEqual({ name, code: "ok" });
  });

  test("the institution itself, in any spelling, is refused, and Pepperstone is now covered", () => {
    const cases: [string, string][] = [
      ["Pepperstone", "trade"], ["Pepperstone Group", "trade"], ["IC Markets", "trade"], ["Interactive Brokers", "trade"], ["Kraken", "crypto"], ["Stake", "trade"],
      ["Coin-Spot", "crypto"], ["Sp0rtsbet", "betting"], ["C0inSpot", "crypto"], ["Ｓｐｏｒｔｓｂｅｔ", "betting"], ["Bet 365", "betting"], ["Sports bet", "betting"],
      ["Sportsbet Pty Ltd", "betting"], ["Binance Australia", "crypto"], ["Bitcoin Deposit", "crypto"], ["Independent Reserve", "crypto"],
    ];
    for (const [name, code] of cases) expect({ name, code: pay({ ...bill, payee: { id: "p1", name, saved: true } }) }).toEqual({ name, code });
    expect(pay({ ...bill, host: "pepperstone.com" })).toBe("trade");
  });

  test("an internationalised (punycode) host is never a payment destination", () => {
    expect(pay({ ...bill, host: "xn--sportsbt-4ya.com" })).toBe("payment-out-of-scope");
    expect(pay({ ...bill, host: "my.xn--nb-7kc.com.au" })).toBe("payment-out-of-scope");
  });
});

// --- stateful repros -------------------------------------------------------------------------------
let dir: string;
let clock: number;
let ledger: SpokenConfirmationLedger;
let approvals: ApprovalService;
let jobs: JobService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b2-review-"));
  clock = Date.parse("2026-09-28T04:00:00Z");
  ledger = new SpokenConfirmationLedger(() => clock);
  approvals = new ApprovalService({ path: join(dir, "a.sqlite"), now: () => clock, spoken: ledger, code: () => "AB3D", telegramCode: () => "AB3D-7XYZ" });
  jobs = new JobService({ path: join(dir, "j.sqlite"), now: () => clock, kill: async () => true, stopGraceMs: 20, accounting: async () => [{ pid: process.pid, ppid: 0, created: 0 }] });
});
afterEach(() => {
  approvals.close();
  jobs.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* WAL */
  }
});

describe("B2: the away code only from the owner's Telegram channel or his OS card", () => {
  test("a loopback-owner or paired-session caller with the right code is refused; Telegram is accepted", () => {
    const r = approvals.request({ action: "away.payment", args: { ...bill, category: "bill" }, requester: usman, summary: "Pay Origin", origin: "principal" });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(approvals.decide(r.approval.id, usman, "approve", { awayCode: "AB3D" })).toMatchObject({ ok: false, code: "wrong-channel" });
    expect(approvals.decide(r.approval.id, { personId: "usman", via: "paired-session", sessionId: "sess-paired-01" }, "approve", { awayCode: "AB3D" })).toMatchObject({ ok: false, code: "wrong-channel" });
    expect(approvals.decide(r.approval.id, usmanTg, "approve", { awayCode: "AB3D" }).ok).toBe(true);
  });

  test("item 2: re-requesting a pending away approval keeps the wrong-code count (3 tries per approval)", () => {
    const req = () => approvals.request({ action: "away.run", args: { task: "delete D:/tmp/a.txt" }, requester: usman, summary: "Delete a.txt", origin: "principal" });
    const r = req();
    if (!r.ok) throw new Error();
    approvals.decide(r.approval.id, usmanTg, "approve", { awayCode: "ZZZ9" });
    approvals.decide(r.approval.id, usmanTg, "approve", { awayCode: "ZZZ8" });
    const again = req();
    expect(again.ok && again.reused).toBe(true);
    expect(approvals.decide(r.approval.id, usmanTg, "approve", { awayCode: "ZZZ7" })).toMatchObject({ code: "rejected" });
  });
});

describe("H1 / B1-R2: a UI confirm answers only what a human asked for in the UI", () => {
  test("a merge a PROCESS requested: no UI confirm counts, even from a real human session; spoken yes or Telegram DM do", () => {
    // A coding job, Hermes or curl: B1 resolves them as actor "process" (here: no actor at all, fail closed).
    const r = approvals.request({ action: "coding.merge", args: { repoId: "x", fromSha: "a".repeat(40) }, requester: usman, summary: "Merge", origin: "principal" });
    if (!r.ok) throw new Error();
    expect(r.telegramCode).toBe("AB3D-7XYZ");
    expect(approvals.card(r.approval.id, usman)).toBeNull();
    // Any local program can drive the owner's browser into a "human" session, so its click isn't proof here.
    const card = approvals.card(r.approval.id, usmanUi)!;
    expect(approvals.decide(r.approval.id, usmanUi, "approve", { uiConfirm: true, cardNonce: card.cardNonce })).toMatchObject({ ok: false, code: "evidence-required" });
    // The code only counts from the owner's Telegram DM, not typed by a local process or in the browser.
    expect(approvals.decide(r.approval.id, usman, "approve", { telegramCode: "AB3D-7XYZ" })).toMatchObject({ ok: false, code: "wrong-channel" });
    expect(approvals.decide(r.approval.id, usmanUi, "approve", { telegramCode: "AB3D-7XYZ" })).toMatchObject({ ok: false, code: "wrong-channel" });
    expect(approvals.decide(r.approval.id, { ...usmanTg, actor: "process" }, "approve", { telegramCode: "AB3D-7XYZ" })).toMatchObject({ ok: false, code: "wrong-channel" });
    expect(approvals.decide(r.approval.id, usmanTg, "approve", { telegramCode: "AB3D-7XYZ" }).ok).toBe(true);
  });

  test("a process request answered by the spoken yes", () => {
    const r = approvals.request({ action: "deploy", args: { site: "muv-marketing" }, requester: usman, summary: "Deploy", origin: "principal" });
    if (!r.ok) throw new Error();
    const q = approvals.ask(r.approval.id, usman);
    clock += 500;
    const yes = ledger.record("yes")!;
    expect(approvals.decide(r.approval.id, usman, "approve", { spokenYes: yes.id, questionId: q.questionId }).ok).toBe(true);
  });

  test("a request the human made in the UI may be confirmed on its card, in the same session", () => {
    const r = approvals.request({ action: "deploy", args: { site: "a" }, requester: usmanUi, summary: "Deploy a", origin: "principal" });
    if (!r.ok) throw new Error();
    expect(r.telegramCode).toBeUndefined();
    const card = approvals.card(r.approval.id, usmanUi)!;
    expect(approvals.decide(r.approval.id, usmanUi, "approve", { uiConfirm: true, cardNonce: card.cardNonce }).ok).toBe(true);
  });

  test("a card nonce is single use and bound to its approval", () => {
    const a = approvals.request({ action: "deploy", args: { site: "a" }, requester: usmanUi, summary: "Deploy a", origin: "principal" });
    const b = approvals.request({ action: "deploy", args: { site: "b" }, requester: usmanUi, summary: "Deploy b", origin: "principal" });
    if (!a.ok || !b.ok) throw new Error();
    const card = approvals.card(a.approval.id, usmanUi)!;
    expect(approvals.decide(b.approval.id, usmanUi, "approve", { uiConfirm: true, cardNonce: card.cardNonce }).ok).toBe(false);
    expect(approvals.decide(a.approval.id, usmanUi, "approve", { uiConfirm: true, cardNonce: card.cardNonce }).ok).toBe(false); // spent by the attempt above
  });

  test("a session id without B1's human actor is not a UI session (fail closed before B1)", () => {
    const r = approvals.request({ action: "deploy", args: { site: "c" }, requester: usmanUi, summary: "Deploy c", origin: "principal" });
    if (!r.ok) throw new Error();
    expect(approvals.card(r.approval.id, { personId: "usman", via: "loopback-owner", sessionId: "sess-usman-0001" })).toBeNull();
    expect(approvals.card(r.approval.id, { personId: "usman", via: "loopback-owner", actor: "process", sessionId: "sess-usman-0001" })).toBeNull();
  });

  test("a Telegram code for a process request dies with a restart; a fresh request issues a new one", () => {
    const r = approvals.request({ action: "deploy", args: { site: "d" }, requester: usman, summary: "Deploy d", origin: "principal" });
    if (!r.ok) throw new Error();
    approvals.close();
    approvals = new ApprovalService({ path: join(dir, "a.sqlite"), now: () => clock, spoken: ledger, code: () => "XY7Z", telegramCode: () => "XY7Z-9WQR" });
    approvals.recover();
    expect(approvals.get(r.approval.id)!.state).toBe("pending"); // still answerable by voice
    const again = approvals.request({ action: "deploy", args: { site: "d" }, requester: usman, summary: "Deploy d", origin: "principal" });
    expect(again.ok && again.reused && again.telegramCode).toBe("XY7Z-9WQR");
    expect(approvals.decide(r.approval.id, usmanTg, "approve", { telegramCode: "XY7Z-9WQR" }).ok).toBe(true);
  });
});

describe("canonical paths (coordinated with B1's route table)", () => {
  test("only exact /__jobs and /__approvals paths are served; dot segments, doubled slashes and escapes are refused, never normalised", async () => {
    const { jobsApprovalsMiddleware, canonicalPath } = await import("../jobs/plugin");
    for (const ok of ["/__jobs", "/__jobs/events", "/__approvals", `/__approvals/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/card`]) expect(canonicalPath(ok)).toBe(true);
    for (const bad of ["/x/../__jobs", "/__jobs/", "/__jobs/./events", "/__jobs//events", "/__jobs/%2e%2e", "/__jobs\\events", "/__jobs%2fevents", "/__approvals/../__jobs"])
      expect({ bad, ok: canonicalPath(bad) }).toEqual({ bad, ok: false });
    const mw = jobsApprovalsMiddleware({ root: dir, deps: { jobs: () => jobs, approvals: () => approvals } });
    for (const url of ["/x/../__jobs", "/__jobs/./events", "/__approvals/%2e%2e/__jobs", "/__jobs/"]) {
      let status = 0;
      let passed = false;
      const res = { statusCode: 0, setHeader() {}, end() { status = (res as { statusCode: number }).statusCode; } };
      const req = { method: "GET", url, headers: { host: "localhost:8081" }, socket: { remoteAddress: "127.0.0.1" }, [Symbol.asyncIterator]: async function* () {} };
      await mw(req as never, res as never, () => (passed = true));
      expect({ url, status, passed }).toEqual({ url, status: 400, passed: false });
    }
  });
});

describe("H2: one spoken yes can't answer a question in another system", () => {
  test("a yes to the control gate's 'open Spotify?' can't approve a pending 'delete the client folder'", () => {
    const control = new ControlDispatchGate(() => clock, ledger);
    const del = approvals.request({ action: "file.delete", args: { path: "D:/clients/harbourview" }, requester: usman, summary: "Delete the client folder", origin: "principal" });
    if (!del.ok) throw new Error();
    const q = approvals.ask(del.approval.id, usman);
    clock += 500;
    control.ask({ task: "open Spotify" }); // the ONE registry: this supersedes the delete question
    clock += 500;
    const yes = ledger.record("yes")!;
    expect(approvals.decide(del.approval.id, usman, "approve", { spokenYes: yes.id, questionId: q.questionId })).toMatchObject({ ok: false, code: "no-spoken-yes" });
    expect(approvals.get(del.approval.id)!.state).toBe("pending");
  });

  test("an approvals question supersedes the control gate's: its yes can't grant control", () => {
    const control = new ControlDispatchGate(() => clock, ledger);
    control.ask({ task: "open Spotify" });
    clock += 500;
    const del = approvals.request({ action: "file.delete", args: { path: "D:/clients/x" }, requester: usman, summary: "Delete x", origin: "principal" });
    if (!del.ok) throw new Error();
    approvals.ask(del.approval.id, usman);
    clock += 500;
    const yes = ledger.record("yes")!;
    expect(() => control.issue({ task: "open Spotify", requestId: "11111111-2222-4333-8444-555555555555" }, { spokenYes: yes.id })).toThrow();
  });

  test("the yes must come from the person (and device) the question was put to", () => {
    const r = approvals.request({ action: "screen.press", args: { window: "Outlook", button: "Send" }, requester: usman, summary: "Press Send", origin: "principal" });
    if (!r.ok) throw new Error();
    const q = approvals.ask(r.approval.id, { personId: "usman", via: "loopback-owner", deviceId: "usman-pc" });
    clock += 500;
    const yes = ledger.record("yes")!;
    expect(approvals.decide(r.approval.id, { personId: "mehroz", via: "companion", deviceId: "mehroz-pc" }, "approve", { spokenYes: yes.id, questionId: q.questionId })).toMatchObject({ ok: false, code: "not-asked" });
    expect(approvals.decide(r.approval.id, { personId: "usman", via: "companion", deviceId: "usman-laptop" }, "approve", { spokenYes: yes.id, questionId: q.questionId })).toMatchObject({ ok: false, code: "not-asked" });
    expect(approvals.decide(r.approval.id, { personId: "usman", via: "loopback-owner", deviceId: "usman-pc" }, "approve", { spokenYes: yes.id, questionId: q.questionId }).ok).toBe(true);
  });

  test("a backward clock step can't make an earlier yes count: the yes is stamped with the open question", () => {
    const r = approvals.request({ action: "file.delete", args: { path: "D:/tmp/x" }, requester: usman, summary: "Delete x", origin: "principal" });
    if (!r.ok) throw new Error();
    const early = ledger.record("yes")!; // said before any question
    clock -= 5_000; // NTP steps back
    const q = approvals.ask(r.approval.id, usman);
    clock += 6_000;
    expect(approvals.decide(r.approval.id, usman, "approve", { spokenYes: early.id, questionId: q.questionId }).ok).toBe(false);
  });
});

describe("H3: an owner-visible, approved release of a quarantine (routes)", () => {
  test("POST release {} asks once; the approved release clears it; nothing re-runs", async () => {
    const deps = { jobs: () => jobs, approvals: () => approvals };
    const job = jobs.create({ kind: "control", principal: usman, targetDeviceId: "usman-pc", title: "Open Notepad" });
    const running = jobs.run(job.id, async () => {
      await Bun.sleep(80); // ignores the stop and finishes late
      return { ok: true };
    });
    await Bun.sleep(5);
    await jobs.cancel(job.id);
    await running;
    expect(jobs.get(job.id)!.quarantined).toBe(true);
    const call = (body: unknown) => jobsApprovalsRoute({ method: "POST", path: `/__jobs/${job.id}/release`, url: new URL("http://x"), body, principal: usmanUi }, deps);
    const ask = await call({});
    expect(ask).toMatchObject({ status: 202 });
    const approvalId = (ask!.body as { approval: { id: string } }).approval.id;
    expect(((await call({}))!.body as { approval: { id: string } }).approval.id).toBe(approvalId); // asked once
    expect(await call({ approvalId })).toMatchObject({ status: 409, body: { result: { reason: "not-approved" } } });
    const card = approvals.card(approvalId, usmanUi)!;
    expect(approvals.decide(approvalId, usmanUi, "approve", { uiConfirm: true, cardNonce: card.cardNonce }).ok).toBe(true);
    expect(await call({ approvalId })).toMatchObject({ status: 200, body: { result: { ok: true }, job: { quarantined: false, state: "succeeded" } } });
    expect(await call({})).toMatchObject({ status: 409 });
  });
});

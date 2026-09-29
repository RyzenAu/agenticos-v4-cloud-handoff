// REVIEW-SAFETY-R5 (28 Sep 2026, round 5): the re-check's cases, kept as permanent tests. Every executor is a
// recording fake; nothing opens a window, a browser, a bank, a wallet or a broker, and nothing is really pressed.
//
//  1. Its 58 new money variants: refused on /screen/act, /screen/command, lessons, control_pc, away mode
//     (payments off and on) and the app browser.
//  2. The over-block (merge blocker): the 68 ordinary controls on 11 pages that merely SHOW an amount (YouTube,
//     Gmail, Sheets, Docs, GitHub, Slack, his dashboards, Canva, Wikipedia, VS Code) aren't refused (only
//     YouTube's paid Join/Thanks are). A non-navigation press where an amount merely appears is ASKED; on a
//     checkout (a total or amount due, a pay/order control or card field, a paying page, a money site) it is
//     REFUSED whatever his yes. Money buttons stay refused everywhere.
//  3. Currencies and pay labels: Rp, RM, Kč, KSh, ZAR, S/, ৳, ₨ and a bare "Total 49.99" make a checkout; its
//     25 labels are refused on those pages; the pay words in them are refused on any page.
//  4. away.payment (still OFF by default): person-to-person on any payment app needs a saved payee; payee
//     matching is confusable-safe; paymentHosts are exact registrable domains; a draw entry is a lottery.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlTaskRefusal, moneyRefusal } from "../src/lib/control-risk";
import { exactRegistrableDomain, moneyContextLevel, paymentIntent, registrableDomain } from "../src/lib/money-policy";
import { gateControlTask, mayRunWithYolo } from "../src/lib/jarvis-control";
import { controlPolicyDecision } from "./jarvis-execution/control-policy";
import { SpokenConfirmationLedger } from "./jarvis-execution/voice-confirmation";
import { ControlDispatchGate } from "./jarvis-execution/server-approval";
import { screenGoalRefusal } from "./screen-hands/refusals";
import { createScreenHands, parseScreenRequest, type Hands } from "./screen-hands/index";
import { createLesson, lessonHermesAllowed, type LessonMinds } from "./screen-hands/lesson";
import type { Overlay } from "./screen-hands/overlay";
import { controlsTextOf, vetAction, type UiElement, type VetContext } from "./screen-hands/plan";
import { hostListed, mixedScript, paymentFence, paymentNever, payeeRegistered } from "./screen-hands/payment";
import { FLAGS_OFF, resolveFlags } from "./screen-hands/flags";
import { createJarvisEntry, type EntryDeps } from "./jev-command";
import { createRunLog } from "./screen-hands/run-log";
import { stubResolveTarget } from "./jev-target";
import { appBrowserUrl } from "./browser/app-browser";
import { awayHermesRefusal, awayVoiceIntent, neverReason } from "./away-mode/policy";
import { createAwayMode } from "./away-mode/runner";
import { auditLog, stateStore } from "./away-mode/store";
import { R5_EVERYDAY_PAGES, R5_LABELS, R5_PRESS_PAGES, R5_PROBES } from "./safety-review-r5.probes";

let nid = 1;
const el = (type: string, name: string, extra: Partial<UiElement> = {}): UiElement => ({
  id: nid++, type, x: 100 + (nid % 8) * 150, y: 100 + (Math.floor(nid / 8) % 5) * 40, w: 120, h: 30, password: false, enabled: true, focused: false, hasValue: false, readOnly: false, name, aid: "", help: "", value: "", ...extra,
});
const address = (url: string) => el("Edit", "Address and search bar", { value: url });
function page(title: string, elements: UiElement[], handle = 7, process = "chrome") {
  const log: string[] = [];
  const state = { title, handle, elements, process };
  const win = () => ({ handle: state.handle, process: state.process, cls: "Chrome_WidgetWin_1", title: state.title });
  const hands: Hands = {
    foreground: async () => (log.push("foreground"), win()),
    windows: async () => [win()],
    focus: async () => true,
    snapshot: async () => (log.push("snapshot"), { window: { x: 0, y: 0, w: 1400, h: 800 }, elements: state.elements, focused: state.elements.find((e) => e.focused) ?? null, browser: true }),
    focused: async () => state.elements.find((e) => e.focused) ?? null,
    at: async () => null,
    click: async () => void log.push("click"),
    press: async (_h, e) => (log.push(`press ${e.name}`), "uia"),
    type: async (_h, t) => void log.push(`type ${t}`),
    keys: async (_h, k) => void log.push(`keys ${k}`),
    wheel: async () => void log.push("wheel"),
    capture: async () => null,
  };
  return { hands, log, state };
}
const acted = (log: string[]) => log.filter((l) => /^(?:click|press|type|keys|wheel)\b/.test(l));
const liveFlags = () => resolveFlags({}, { recheck: true, denylist: true, jevIrreversible: true, refs: true, jevStep: true, formFill: true, replay: true });
const overlay = new Proxy({}, { get: (_t, k) => (k === "stat" || k === "excludeFromCapture" ? async () => null : k === "onClick" ? () => () => undefined : () => undefined) }) as unknown as Overlay;
const OWNER = "8550678495";

type PageSpec = { title: string; url: string; texts: string[]; button: string };
/** The real away runner on a synthetic page. `hosts`/`payees`: what he registered for away.payment. */
function away(spec: PageSpec | null, options: { payments?: boolean; hosts?: string[]; payees?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "away-r5-"));
  const log: string[] = [];
  const st = { title: spec?.title ?? "Untitled - Notepad", elements: spec ? [address(spec.url), ...spec.texts.map((t) => el("Text", t)), el("Button", spec.button)] : ([] as UiElement[]) };
  const win = () => ({ handle: 21, process: "chrome", cls: "Chrome_WidgetWin_1", title: st.title });
  const hands: Hands = {
    foreground: async () => win(), windows: async () => [win()], focus: async () => true,
    snapshot: async () => ({ window: { x: 0, y: 0, w: 1400, h: 800 }, elements: st.elements, focused: null, browser: true }),
    focused: async () => null, at: async () => null, click: async () => void log.push("click"),
    press: async (_h, e) => {
      log.push(`press ${e.name}`);
      if (spec) {
        st.title = "Payment received - Google Chrome";
        st.elements = [address(spec.url), el("Text", "Thank you for your payment"), el("Text", "Reference TX12345")];
      }
      return "uia";
    },
    type: async (_h, t) => void log.push(`type ${t}`), keys: async (_h, k) => void log.push(`keys ${k}`), wheel: async () => void log.push("wheel"), capture: async () => null,
  };
  const real = createScreenHands({ key: () => "", hands, flags: () => ({ ...FLAGS_OFF, denylist: true }), audit: null, jarvisChrome: null });
  const hermes: string[] = [];
  const sentinel = { running: true, async start() { return true; }, stop() {}, async locked() { return false; }, async idleMs() { return 60_000; }, async shot() { return false; }, onInput() { return () => {}; } };
  const mode = createAwayMode({
    store: stateStore(join(dir, "state")), audit: auditLog(join(dir, "data")), sentinel: sentinel as never,
    notify: async () => ({ ok: true, detail: "sent" }),
    screen: { act: (req, s) => real.act(req, s), stopAll: () => 0, flags: () => ({ denylist: true }), foreground: async () => win(), snapshot: async () => ({ window: { x: 0, y: 0, w: 1400, h: 800 }, elements: st.elements, focused: null, browser: true }), windows: async () => [win()], focus: async () => true },
    hermes: async (p: string) => (hermes.push(p), "ok"), cli: async () => ({ ok: true, output: "ok" }),
    files: { exists: () => false, mkdir: async () => {}, write: async () => {}, recycle: async () => {} },
    launch: async (app: string) => ({ ok: true, said: `${app} is opening.` }),
    ownerChat: () => OWNER, home: "C:\\Users\\Nebula PC", code: () => "7F3K", sleep: async () => undefined,
    config: { tickMs: 1e9, approvalTtlMs: 30 * 60_000, armIdleMs: 15_000, launchWaitMs: 1000, payments: options.payments ?? false, paymentHosts: options.hosts ?? [], savedPayees: options.payees ?? [] },
  });
  const msg = (text: string) => mode.telegram({ platform: "telegram", userId: OWNER, chatId: OWNER, chatType: "dm", text });
  const settle = async () => {
    const end = Date.now() + 10_000;
    let idle = 0;
    while (Date.now() < end && idle < 20) {
      await new Promise((r) => setTimeout(r, 2));
      const t = mode.status().tasks.at(-1);
      if (mode.busy || mode.running !== null || t?.status === "running" || t?.status === "queued") {
        idle = 0;
        if (!mode.busy && mode.running === null) await mode.tick();
        continue;
      }
      idle++;
    }
  };
  const last = () => mode.status().tasks.at(-1)!;
  return { mode, msg, settle, log, st, hermes, last, presses: () => log.filter((l) => /^(?:press|click)\b/.test(l)), close: () => (mode.close(), rmSync(dir, { recursive: true, force: true })) };
}
const ctxOf = (title: string, url: string | null, text: string, process = "chrome", extra: Partial<VetContext> = {}): VetContext => ({
  focused: null, browser: process === "chrome", deny: true, window: { handle: 7, process, cls: "x", title } as never, dialogText: `${title}\n${text}`, url, ...extra,
});

// ---------------------------------------------------------------------------------------------------------
describe("1. the re-check's 58 money variants, refused on every path", () => {
  test("the list is the reviewer's (58 variants, 36 never-kinds)", () => {
    expect(R5_PROBES).toHaveLength(58);
    expect(R5_PROBES.filter(([, c]) => c === "N")).toHaveLength(36);
  });
  test.each(R5_PROBES.map(([k, c, p]) => [k, c, p] as const))("[%s/%s] %p", async (_kind, _cls, p) => {
    expect(moneyRefusal(p)).not.toBeNull();
    expect(screenGoalRefusal(p)).not.toBeNull();
    const ledger = new SpokenConfirmationLedger();
    const yes = ledger.record("yes")!;
    const w = page("New Tab - Google Chrome", [address(""), el("Button", "Pay"), el("Button", "Send"), el("Button", "Confirm")]);
    const screen = createScreenHands({ key: () => "", hands: w.hands, flags: liveFlags, audit: null, jarvisChrome: null, spoken: ledger });
    expect(await screen.act(parseScreenRequest({ goal: p, confirm: "Pay", spokenYes: yes.id }), new AbortController().signal)).toMatchObject({ ok: false, refused: true });
    expect(w.log).toEqual([]);
    const calls: string[] = [];
    const deps: EntryDeps = {
      screen: { runs: createRunLog(), act: (async () => (calls.push("screen"), { type: "done", ok: true, said: "x", steps: 1, ms: 1, stepMs: [1] })) as EntryDeps["screen"]["act"] },
      jevKey: () => "synthetic-key",
      request: (async () => (calls.push("jev"), new Response("{}"))) as unknown as typeof fetch,
      front: async () => ({ process: "chrome", title: "New Tab - Google Chrome" }),
      browser: async () => (calls.push("browser"), null),
      summarise: null,
      files: { open: async () => void calls.push("file"), titles: async () => [] },
      openApp: async () => (calls.push("app"), { ok: true, said: "x" }),
      resolver: { resolve: stubResolveTarget, source: "stub" },
    };
    // S2d (owner decision 29 Sep, "money requests are fine"): the entry routes the request instead of refusing it;
    // the executors it can reach refuse to act (the screen executor, the app browser), and no app or file opens.
    expect((await createJarvisEntry(deps).handle({ utterance: p }, new AbortController().signal)).kind).not.toBe("refused");
    expect(calls.filter((c) => c === "app" || c === "file")).toEqual([]);
    const now = Date.now();
    expect(controlTaskRefusal(p)).not.toBeNull();
    expect(gateControlTask({ task: p, confirmed: false, pending: null, lastUserUtterance: "", now }).action).toBe("refuse");
    expect(gateControlTask({ task: p, confirmed: true, pending: { task: p, at: now - 1000 }, lastUserUtterance: "yes", spokenYes: crypto.randomUUID(), now }).action).toBe("refuse");
    expect(mayRunWithYolo(p, { task: p, tier: "external-effect", method: "spoken-yes", at: now }).ok).toBe(false);
    expect(controlPolicyDecision(p).permitted).toBe(false);
    let t = 1_000_000;
    const l2 = new SpokenConfirmationLedger(() => t);
    const gate = new ControlDispatchGate(() => t, l2);
    gate.ask({ task: p });
    t += 1000;
    const y2 = l2.record("yes")!;
    expect(() => gate.issue({ task: p, requestId: crypto.randomUUID() }, { spokenYes: y2.id })).toThrow("refused whatever the approval");
    expect(neverReason(p)).not.toBeNull();
    expect(awayHermesRefusal(p)).not.toBeNull();
    const lw = page("New Tab - Google Chrome", []);
    const minds = { coach: async () => null, next: async () => null, research: async () => null } as unknown as LessonMinds;
    const lesson = createLesson({ goal: p, mode: "drive" }, { hands: lw.hands, overlay, minds, flags: () => ({ ...FLAGS_OFF }), sleep: async () => undefined });
    expect((await lesson.started).state).toBe("ended");
    lesson.stop();
    expect(acted(lw.log)).toEqual([]);
    expect(lessonHermesAllowed(p)).toBe(false);
    const url = p.match(/https?:\/\/\S+/)?.[0];
    if (url) expect(appBrowserUrl(url).ok).toBe(false);
  });
  test.each(R5_PROBES.filter(([, c]) => c === "N").map(([k, , p]) => [k, p]))("away.payment reads a never-kind as never: [%s] %p", (_k, p) => {
    const intent = paymentIntent(p);
    expect({ p, never: !!intent && "never" in intent }).toEqual({ p, never: true });
  });
  test.each(["payments off", "payments on"] as const)("the real away runner (%s): every variant refused, via Telegram and voice; nothing to Hermes, no code asked", async (mode) => {
    const h = away(null, { payments: mode === "payments on", hosts: ["telstra.com.au"] });
    try {
      await h.msg("/away on");
      const notRefused: Array<[string, string]> = [];
      for (const [i, [, , p]] of R5_PROBES.entries()) {
        if (i % 2) await h.msg(`/task ${p}`);
        else {
          const intent = awayVoiceIntent(`Jarvis, while I'm away, ${p}`);
          expect(intent && "task" in intent).toBe(true);
          await h.mode.voice(intent!);
        }
        await h.settle();
        if (h.last().status !== "refused") notRefused.push([p, h.last().status]);
        expect(h.mode.status().pending).toBeNull();
      }
      expect(notRefused).toEqual([]);
      expect(h.hermes).toEqual([]);
      expect(h.presses()).toEqual([]);
    } finally {
      h.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("2. the over-block: pages that merely show an amount", () => {
  test("the list is the reviewer's (11 pages, 68 controls)", () => {
    expect(R5_EVERYDAY_PAGES).toHaveLength(11);
    expect(R5_EVERYDAY_PAGES.flatMap((p) => p.labels)).toHaveLength(68);
  });
  const CELLS = R5_EVERYDAY_PAGES.flatMap((p) => p.labels.map((l) => [p.name, l] as const));
  test.each(CELLS)("%s: %p isn't refused (only YouTube's paid Join and Thanks are)", (name, label) => {
    const p = R5_EVERYDAY_PAGES.find((x) => x.name === name)!;
    const ctx = ctxOf(p.title, p.url, p.text, p.process);
    const element = el("Button", label);
    const v = vetAction({ do: "click", element }, ctx);
    const paid = /YouTube/.test(name) && /^(?:Join|Thanks)$/.test(label);
    expect({ label, refused: v.refused === true }).toEqual({ label, refused: paid });
    // Asked at most, and his yes then presses it.
    if (!paid) expect({ label, v: vetAction({ do: "click", element }, { ...ctx, confirmed: label }) }).toEqual({ label, v: { ok: true } });
  });
  test("Gmail, Slack, Docs, Sheets and his dashboards are unaffected: the amount changes nothing", () => {
    for (const p of R5_EVERYDAY_PAGES.filter((x) => /Gmail|Slack|Google (?:Doc|Sheet)|dashboard|Finance/.test(x.name))) {
      for (const label of p.labels) {
        const element = el("Button", label);
        const withMoney = vetAction({ do: "click", element }, ctxOf(p.title, p.url, p.text, p.process));
        const without = vetAction({ do: "click", element }, ctxOf(p.title, p.url, "Nothing about money here", p.process));
        expect({ page: p.name, label, v: withMoney }).toEqual({ page: p.name, label, v: without });
      }
    }
  });
  test("an amount merely in the text ASKS (and his yes presses); unattended it's refused", () => {
    const ctx = ctxOf("Acme Store - Google Chrome", "https://shop.acme-store.example/item/42", "Wireless headphones\n€49,99\nIn stock");
    for (const label of ["Add to wishlist", "Notify me", "Compare"]) {
      const element = el("Button", label);
      expect(vetAction({ do: "click", element }, ctx)).toMatchObject({ ok: false, confirm: label });
      expect(vetAction({ do: "click", element }, { ...ctx, confirmed: label })).toEqual({ ok: true });
      expect(vetAction({ do: "click", element }, { ...ctx, unattended: true })).toMatchObject({ ok: false, refused: true });
    }
    // Enter on that page: asked, not refused.
    const focused = el("Button", "Notify me", { focused: true });
    expect(vetAction({ do: "key", keys: "enter", label: "enter" }, { ...ctx, focused })).toMatchObject({ ok: false, confirm: "enter" });
    // Money buttons stay refused there whatever his yes.
    for (const label of ["Buy now", "Add to cart", "Pay", "Betala"]) expect(vetAction({ do: "click", element: el("Button", label) }, { ...ctx, confirmed: label })).toMatchObject({ ok: false, refused: true });
  });
  test("a checkout REFUSES whatever his yes: a total block, a card field, a place-order control, a checkout path", () => {
    const checkouts: Array<[string, VetContext]> = [
      ["total block", ctxOf("Acme - Google Chrome", "https://shop.acme.example/x", "Your items\nTotal 49.99")],
      ["amount due", ctxOf("Acme - Google Chrome", "https://shop.acme.example/x", "Amount due: 1 234,00")],
      ["order summary", ctxOf("Acme - Google Chrome", "https://shop.acme.example/x", "Order summary\n2 items")],
      ["card field (no amount)", ctxOf("Acme - Google Chrome", "https://shop.acme.example/x", "Almost done", "chrome", { controls: "Card number cardnumber\nExpiry date\nNext" })],
      ["place-order control", ctxOf("Acme - Google Chrome", "https://shop.acme.example/x", "Almost done", "chrome", { controls: "Place order\nBack" })],
      ["checkout path", ctxOf("Acme - Google Chrome", "https://shop.acme.example/checkout/shipping", "Step 1 of 3")],
    ];
    for (const [name, ctx] of checkouts)
      for (const label of ["Next", "Continue", "Weiter", "Do it", "Add to wishlist"]) {
        expect({ name, label, v: vetAction({ do: "click", element: el("Button", label) }, { ...ctx, confirmed: label }) }).toMatchObject({ name, label, v: { ok: false, refused: true } });
      }
  });
  test("a product page's Buy now / Add to cart controls don't make its other presses checkout presses", () => {
    const ctx = ctxOf("Acme - Google Chrome", "https://shop.acme.example/p/1", "Headphones\n$129.00", "chrome", { controls: "Buy now\nAdd to cart\nCheckout\nReviews" });
    expect(vetAction({ do: "click", element: el("Button", "Add to wishlist") }, ctx)).toMatchObject({ ok: false, confirm: "Add to wishlist" });
  });
  test("controlsTextOf lists the page's buttons, links and fields (name and id)", () => {
    const text = controlsTextOf({ elements: [el("Button", "Place order", { aid: "place_order" }), el("Edit", "Card number"), el("Text", "Total $5"), el("Hyperlink", "Help")] });
    expect(text.split("\n")).toEqual(["Place order place order", "Card number", "Help"]);
  });
  test("real /screen/act: a card-field page refuses Next with no amount shown; nothing pressed", async () => {
    const w = page("Acme - Google Chrome", [address("https://shop.acme.example/x"), el("Text", "Almost done"), el("Edit", "Card number"), el("Button", "Next")]);
    const screen = createScreenHands({ key: () => "", hands: w.hands, flags: liveFlags, audit: null, jarvisChrome: null, spoken: new SpokenConfirmationLedger() });
    const done = await screen.act(parseScreenRequest({ goal: "click Next" }), new AbortController().signal);
    expect({ refused: done.refused === true, asked: !!done.confirm }).toEqual({ refused: true, asked: false });
    expect(acted(w.log)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("3. currencies and pay labels", () => {
  const TRANSACTIONAL = ["Total Rp 150.000", "Total RM 49.90", "Total 4 990 Ft", "Celkem 499 Kč", "Razem 49,99 zł", "Total KSh 500", "Total ₱499", "Total 499 kr", "Total R 199.00", "Total S/ 50.00", "Total 50 TL", "Total ৳500", "Total ₨ 500", "Total 500 Rs.", "Total 1,99 €", "Итого 499 ₽", "合计 ¥499", "总计 499 元", "합계 ₩49,000", "Total 49.99", "Order summary", "Att betala 499 kr", "Amount due 120", "You're sending $500.00 to Sam", "$20 will be charged to your card"];
  test.each(TRANSACTIONAL)("%p makes the page a checkout", (t) => {
    expect(moneyContextLevel({ title: "Shop - Google Chrome", url: "https://shop.example/x", text: `Shop\n${t}`, process: "chrome" })?.level).toBe("transactional");
  });
  test("an amount in running text is incidental; content sites and his documents aren't money pages", () => {
    for (const t of ["Precio 49,99 EUR", "fifty dollars", "Rp 150.000 each", "RM 49.90 per box"]) expect({ t, l: moneyContextLevel({ title: "Shop - Google Chrome", url: "https://shop.example/x", text: `Shop\n${t}`, process: "chrome" })?.level }).toEqual({ t, l: "incidental" });
    expect(moneyContextLevel({ title: "Video - YouTube", url: "https://www.youtube.com/watch?v=1", text: "plans from $5/month", process: "chrome" })).toBeNull();
    expect(moneyContextLevel({ title: "a total of 5 people came", url: "https://news.example/x", text: "a total of 5 people came", process: "chrome" })?.level).not.toBe("transactional");
  });
  test("the list is the reviewer's (25 labels, 7 pages)", () => {
    expect(R5_LABELS).toHaveLength(25);
    expect(R5_PRESS_PAGES).toHaveLength(7);
  });
  const MONEY_PAGES = new Set(["SEK 499", "Rp 150.000", "step 1 of 3 shipping (no amount yet)"]);
  const PAY_WORDS = ["Betala", "Maksa", "Zapłać", "Kupuję i płacę", "Plaćanje", "Ödeme yap", "ชำระเงิน", "Thanh toán", "Magbayad", "Lipa", "Swish", "Vipps", "Hold to pay", "Slide to pay", "Upgrade me"];
  test.each(R5_LABELS)("%p: refused whatever his yes on the Kr/Rp/checkout pages; a pay word is refused on every page", (label) => {
    for (const [name, title, url, text] of R5_PRESS_PAGES) {
      const v = vetAction({ do: "click", element: el("Button", label) }, { ...ctxOf(title, url, text), confirmed: label });
      if (MONEY_PAGES.has(name) || PAY_WORDS.includes(label)) expect({ label, name, v }).toMatchObject({ label, name, v: { ok: false, refused: true } });
    }
  });
  test("on the Rp page with no yes, none of the 25 is pressed without a question", () => {
    const pressed = R5_LABELS.filter((l) => vetAction({ do: "click", element: el("Button", l) }, ctxOf("Acme - Google Chrome", "https://toko.acme.example/k", "Total Rp 150.000")).ok);
    expect(pressed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("4. away.payment: person-to-person, confusable payees, exact hosts, draws", () => {
  test("person-to-person on a registered payment app needs a saved payee (PayPal, Beem, Wise, Revolut)", () => {
    const cases: Array<[string, string, string, string]> = [
      ["PayPal - Google Chrome", "https://www.paypal.com/myaccount/transfer/homepage/pay", "Paying: Sam Smith\nAmount A$500.00", "paypal.com"],
      ["Review details - Wise - Google Chrome", "https://wise.com/send/review", "Recipient: Sam Smith\nYou send A$500.00", "wise.com"],
      ["Beem - Google Chrome", "https://app.beem.com.au/pay", "Pay to: Zaid Ahmed\nAmount A$60.00", "beem.com.au"],
      ["Revolut - Google Chrome", "https://app.revolut.com/transfers", "Paying: Sam Smith\nAmount A$60.00", "revolut.com"],
    ];
    for (const [title, url, texts, host] of cases) {
      expect({ title, r: paymentFence(title, url, texts, { hosts: [host], payees: [] }) }).toMatchObject({ title, r: expect.stringMatching(/saved-payee list/) });
      const payee = /(?:Paying|Recipient|Pay to): ([^\n]+)/.exec(texts)![1];
      expect({ title, r: paymentFence(title, url, texts, { hosts: [host], payees: [payee] }) }).toEqual({ title, r: null });
    }
  });
  test("a page naming two payees ('Paying: Telstra' over the real recipient's email) is refused", () => {
    expect(paymentFence("Send money - PayPal - Google Chrome", "https://www.paypal.com/myaccount/transfer/send", "Paying: Telstra\nRecipient email: refunds@telstra-billing.example\nAmount A$500.00", { hosts: ["paypal.com"], payees: ["Telstra"] })).toMatch(/more than one payee/);
  });
  test("the real runner: PayPal and Beem P2P to unsaved people are refused, no code asked, nothing pressed", async () => {
    for (const [task, spec, host] of [
      ["pay the PayPal bill: open Chrome, click Pay", { title: "PayPal - Google Chrome", url: "https://www.paypal.com/myaccount/transfer/homepage/pay", texts: ["Paying: Sam Smith", "Amount A$500.00"], button: "Pay" }, "paypal.com"],
      ["pay Zaid's invoice: open Chrome, click Pay", { title: "Beem - Google Chrome", url: "https://app.beem.com.au/pay", texts: ["Pay to: Zaid Ahmed", "Amount A$60.00"], button: "Pay" }, "beem.com.au"],
    ] as Array<[string, PageSpec, string]>) {
      const h = away(spec, { payments: true, hosts: [host] });
      try {
        await h.msg("/away on");
        await h.msg(`/task ${task}`);
        await h.settle();
        expect({ task, status: h.last().status, pending: h.mode.status().pending, presses: h.presses() }).toEqual({ task, status: "refused", pending: null, presses: [] });
      } finally {
        h.close();
      }
    }
  });
  test("saved-payee matching is confusable-safe: lookalikes, mixed scripts, full-width and invisible characters never match", () => {
    const saved = ["Mehroz Khan"];
    expect(payeeRegistered(saved, "Mehroz Khan")).toBe(true);
    expect(payeeRegistered(saved, "mehroz  khan")).toBe(true);
    for (const fake of ["Меhrоz Khаn", "Mehroz Кhan", "Ｍehroz Khan", "Meh\u200Broz Khan", "Mehroz\u2060Khan", "Mehroz Khan\u200D", "Mehroż Khan", "Mehr0z Khan"]) expect({ fake, ok: payeeRegistered(saved, fake) }).toEqual({ fake, ok: false });
    expect(mixedScript("Меhrоz Khаn")).toBe(true);
    expect(mixedScript("Мехроз Хан")).toBe(false);
    expect(payeeRegistered(["Мехроз Хан"], "Мехроз Хан")).toBe(true);
    // The fence: a Cyrillic lookalike of a saved payee on his bank is refused.
    expect(paymentFence("Pay anyone - NetBank - Google Chrome", "https://www.my.commbank.com.au/netbank/pay", "Payee: Меhrоz Khаn\nAmount $500.00", { hosts: ["commbank.com.au"], payees: saved })).toMatch(/saved-payee list/);
    expect(paymentFence("Pay anyone - NetBank - Google Chrome", "https://www.my.commbank.com.au/netbank/pay", "Payee: Mehroz Khan\nAmount $500.00", { hosts: ["commbank.com.au"], payees: saved })).toBeNull();
  });
  test("the real runner: a Cyrillic-lookalike payee is refused even with the Latin name saved", async () => {
    const h = away({ title: "Pay anyone - NetBank - Google Chrome", url: "https://www.my.commbank.com.au/netbank/pay", texts: ["Payee: Меhrоz Khаn", "Amount $500.00"], button: "Pay" }, { payments: true, hosts: ["commbank.com.au"], payees: ["Mehroz Khan"] });
    try {
      await h.msg("/away on");
      await h.msg("/task pay my saved payee Mehroz: open Chrome, click Pay");
      await h.settle();
      expect({ status: h.last().status, pending: h.mode.status().pending, presses: h.presses() }).toEqual({ status: "refused", pending: null, presses: [] });
    } finally {
      h.close();
    }
  });
  test("paymentHosts are exact registrable domains: public suffixes and shared hosting are rejected", () => {
    for (const bad of ["com.au", "co.uk", "au", "com", "vercel.app", "github.io", "netlify.app", "pages.dev", "web.app", "herokuapp.com", "myshopify.com", "blogspot.com", "checkout.stripe.com", "www2.telstra.com.au", "1.2.3.4", "xn--80ak6aa92e.com", "gov.au", "nsw.gov.au"])
      expect({ bad, r: exactRegistrableDomain(bad) }).toEqual({ bad, r: null });
    for (const [good, norm] of [["stripe.com", "stripe.com"], ["telstra.com.au", "telstra.com.au"], ["www.amazon.com.au", "amazon.com.au"], ["mu-receptionist.vercel.app", "mu-receptionist.vercel.app"], ["service.nsw.gov.au", "service.nsw.gov.au"]])
      expect({ good, r: exactRegistrableDomain(good) }).toEqual({ good, r: norm });
    expect(registrableDomain("checkout.stripe.com")).toBe("stripe.com");
    expect(registrableDomain("evil.vercel.app")).toBe("evil.vercel.app");
    expect(registrableDomain("com.au")).toBeNull();
    // Listing: a host is covered only by its own registrable domain.
    expect(hostListed(["stripe.com"], "checkout.stripe.com")).toBe(true);
    expect(hostListed(["com.au"], "www.dodgyshop.com.au")).toBe(false);
    expect(hostListed(["vercel.app"], "telstra-pay-bill.vercel.app")).toBe(false);
    expect(hostListed(["mu-receptionist.vercel.app"], "mu-receptionist.vercel.app")).toBe(true);
    expect(hostListed(["mu-receptionist.vercel.app"], "evil.vercel.app")).toBe(false);
    expect(hostListed(["telstra.com.au"], "telstra.com.au.evil.example")).toBe(false);
  });
  test("the real runner: 'com.au' or 'vercel.app' on the list makes nothing payable", async () => {
    for (const [hosts, spec] of [
      [["com.au"], { title: "Checkout - DodgyShop - Google Chrome", url: "https://www.dodgyshop.com.au/checkout", texts: ["Merchant: DodgyShop", "Total A$899.00"], button: "Pay" }],
      [["vercel.app"], { title: "Telstra Bill - Google Chrome", url: "https://telstra-pay-bill.vercel.app/pay", texts: ["Payee: Telstra", "Amount due A$123.45"], button: "Pay" }],
    ] as Array<[string[], PageSpec]>) {
      const h = away(spec, { payments: true, hosts });
      try {
        await h.msg("/away on");
        await h.msg("/task pay my bill: open Chrome, click Pay");
        await h.settle();
        expect({ hosts, status: h.last().status, pending: h.mode.status().pending, presses: h.presses() }).toEqual({ hosts, status: "refused", pending: null, presses: [] });
      } finally {
        h.close();
      }
    }
  });
  test("a crypto, broker or betting brand named on a shop's checkout (a 'Bitaroo digital voucher' on Amazon) is never approvable", () => {
    expect(paymentNever("Checkout - Amazon.com.au - Google Chrome", "https://www.amazon.com.au/gp/buy/spc", "Bitaroo digital voucher\nOrder total A$500.00")).toMatch(/crypto/);
    expect(paymentNever("Checkout - Amazon.com.au - Google Chrome", "https://www.amazon.com.au/gp/buy/spc", "Sportsbet gift card\nOrder total A$50.00")).toMatch(/betting/);
    expect(paymentNever("Checkout - Amazon.com.au - Google Chrome", "https://www.amazon.com.au/gp/buy/spc", "Apple Gift Card - A$50\nOrder total A$50.00")).toBeNull();
  });
  test("gift cards and vouchers keep their pre-R5 away.payment kind (purchase) until the owner decides", () => {
    for (const p of ["buy a $50 Steam gift card", "get a JB Hi-Fi voucher", "pick up a Prezzee card for Bianca", "send Mehroz an eGift"]) expect({ p, i: paymentIntent(p) }).toEqual({ p, i: { approvable: "purchase" } });
  });
  test("a draw entry, raffle, art union, prize home or sweep is a lottery: never approvable", async () => {
    for (const p of ["buy the draw entry", "get me 3 raffle tickets", "enter the prize home draw", "buy an art union ticket", "put $20 in the office sweep", "grab a sweepstakes entry"]) {
      expect({ p, i: paymentIntent(p) }).toEqual({ p, i: { never: "betting" } });
    }
    expect(paymentNever("Prize Home Draw - RSL Art Union - Google Chrome", "https://www.rslartunion.com.au/buy", "3 entries\nTotal A$30.00")).toMatch(/lottery/);
    expect(paymentNever("Enter now - Google Chrome", "https://www.charity.example/enter", "Your draw entries: 3\nTotal A$30.00")).toMatch(/lottery/);
    const h = away({ title: "Prize Home Draw - RSL Art Union - Google Chrome", url: "https://www.rslartunion.com.au/buy", texts: ["3 entries", "Total A$30.00"], button: "Enter now" }, { payments: true, hosts: ["rslartunion.com.au"] });
    try {
      await h.msg("/away on");
      await h.msg("/task buy the draw entry: open Chrome, click Enter now");
      await h.settle();
      expect({ status: h.last().status, pending: h.mode.status().pending, presses: h.presses() }).toEqual({ status: "refused", pending: null, presses: [] });
    } finally {
      h.close();
    }
  });
});

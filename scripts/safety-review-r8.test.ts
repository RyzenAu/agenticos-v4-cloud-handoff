// REVIEW-SAFETY-R4.md, R8 residuals (28 Sep 2026), fixed on f/safety-r8-20260928:
//  1. The amount-box rule applies inside mail and chat too (a Nitro gift in a chat, "Send money with Google Pay"
//     in Gmail); a message that merely mentions an amount still doesn't.
//  2. Amount boxes are judged by the control's containing box or dialog (the helper's new "B" rows), not a fixed
//     radius; the radius is only the fallback when no container is known.
//  3. "Choose an amount" (in the supported languages) or a progress bar plus a frame is a payment step; amount
//     pickers (choosable controls named only by an amount) are money.
//  4. The R5 allowlist-abuse set re-run against the current payment runner (P2P, confusable payees, public
//     suffixes, raffles, crypto on a registered host).
// Also: the real helper now reads Text, Image, ProgressBar and Custom elements (it read only interactive controls
// before, so the page-text rules saw little more than the title in production) and container rectangles.
// Every case runs on recording fakes; nothing is really pressed and no window is read.
import { describe, expect, test, setDefaultTimeout } from "bun:test";
// (Each case drives the real screen or away loop several times; a loaded machine can take over 5 s.)
setDefaultTimeout(30_000);
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moneyContextLevel } from "../src/lib/money-policy";
import { SpokenConfirmationLedger } from "./jarvis-execution/voice-confirmation";
import { createScreenHands, parseScreenRequest, type Hands } from "./screen-hands/index";
import { amountOnly, amountPickerOf, containerOf, dialogOf, nearbyTextOf, parseSnapshot, vetAction, type UiElement } from "./screen-hands/plan";
import { FLAGS_OFF, resolveFlags } from "./screen-hands/flags";
import { SCREEN_PRELUDE } from "./screen-hands/native";
import { createAwayMode } from "./away-mode/runner";
import { auditLog, stateStore } from "./away-mode/store";

let nid = 1;
const el = (type: string, name: string, extra: Partial<UiElement> = {}): UiElement => ({
  id: nid++, type, x: 100 + (nid % 8) * 150, y: 100 + (Math.floor(nid / 8) % 5) * 40, w: 120, h: 30, password: false, enabled: true, focused: false, hasValue: false, readOnly: false, name, aid: "", help: "", value: "", ...extra,
});
const at = (type: string, name: string, x: number, y: number, w = 80, h = 30) => el(type, name, { x, y, w, h });
const T = (n: string) => el("Text", n);
const address = (url: string) => el("Edit", "Address and search bar", { value: url });
const liveFlags = () => resolveFlags({}, { recheck: true, denylist: true, jevIrreversible: true, refs: true, jevStep: true, formFill: true, replay: true });
type Case = { name: string; title: string; url: string; els: () => UiElement[]; label: string; btn?: Partial<UiElement>; btnType?: string; boxes?: UiElement[]; unattended?: boolean };
async function run(c: Case) {
  const log: string[] = [];
  // Without explicit positions the page is one box (texts stacked above the button), as a dialog renders; the
  // counter-based default positions vary with test order.
  const els = c.els();
  const laidOut = c.btn ? els : els.map((e, i) => (e.type === "Document" || e.type === "ProgressBar" ? e : { ...e, x: 500, y: 200 + i * 40 }));
  const elements = [address(c.url), ...laidOut, el(c.btnType ?? "Button", c.label, c.btn ?? { x: 500, y: 200 + els.length * 40 })];
  const win = () => ({ handle: 7, process: "chrome", cls: "Chrome_WidgetWin_1", title: c.title });
  const snap = () => ({ window: { x: 0, y: 0, w: 1400, h: 1000 }, elements, focused: null, browser: true, ...(c.boxes ? { boxes: c.boxes } : {}) });
  const hands: Hands = {
    foreground: async () => win(), windows: async () => [win()], focus: async () => true, snapshot: async () => snap(),
    focused: async () => null, at: async () => null,
    click: async () => void log.push("click"), press: async (_h, e) => (log.push(`press ${e.name}`), "uia"),
    type: async (_h, t) => void log.push(`type ${t}`), keys: async (_h, k) => void log.push(`keys ${k}`), wheel: async () => void log.push("wheel"), capture: async () => null,
  };
  const ledger = new SpokenConfirmationLedger();
  const screen = createScreenHands({ key: () => "", hands, flags: liveFlags, audit: null, jarvisChrome: null, spoken: ledger });
  const goal = `click ${c.label}`;
  const d1 = await screen.act({ ...parseScreenRequest({ goal }), ...(c.unattended ? { unattended: true } : {}) }, new AbortController().signal);
  const pressed = () => log.some((l) => /^(?:press|click)/.test(l));
  if (d1.refused) return "refused";
  if (!d1.confirm) return pressed() ? "PRESSED (no question)" : "not pressed";
  await new Promise((r) => setTimeout(r, 5));
  const y = ledger.record("yes")!;
  await screen.act(parseScreenRequest({ goal, confirm: d1.confirm, spokenYes: y.id }), new AbortController().signal);
  return pressed() ? "asked → PRESSED after yes" : "asked → not pressed";
}

const shop = "Acme - Google Chrome";
/** The reviewer's 15 R8 variants (r4/r8-cases.ts), verbatim positions, with today's outcome. */
const R8_CASES: Array<[Case, string]> = [
  [{ name: "tip box: amount 290 px from Send", title: shop, url: "https://acme.example/post/1", els: () => [T("Enjoying this?"), at("RadioButton", "$5", 100, 400)], label: "Send", btn: { x: 390, y: 400, w: 80, h: 30 } }, "refused"],
  [{ name: "tip box: amount 320 px from Send", title: shop, url: "https://acme.example/post/1", els: () => [T("Enjoying this?"), at("RadioButton", "$5", 100, 400)], label: "Send", btn: { x: 420, y: 400, w: 80, h: 30 } }, "refused"],
  [{ name: "tip box: amount 600 px away (below)", title: shop, url: "https://acme.example/post/1", els: () => [T("Enjoying this?"), at("RadioButton", "$5", 100, 900)], label: "Send", btn: { x: 100, y: 300, w: 80, h: 30 } }, "asked → PRESSED after yes"], // (no box known and beyond the radius: asked, as at base; a dialog box makes it refused, section 2)
  [{ name: "recurring price in words, Continue", title: "Plans - Google Chrome", url: "https://acme.example/join", els: () => [T("Only fourteen dollars a month")], label: "Continue" }, "refused"],
  [{ name: "recurring 'billed yearly A$120', Continue", title: shop, url: "https://acme.example/join", els: () => [T("A$120 billed yearly")], label: "Continue" }, "refused"],
  [{ name: "amounts as Images inside a box, 'Next'", title: shop, url: "https://acme.example/support", els: () => [at("Image", "$5", 100, 400), at("Image", "$10", 200, 400)], label: "Next", btn: { x: 320, y: 400, w: 80, h: 30 } }, "refused"],
  [{ name: "amounts as unnamed images + 'Choose an amount', Next", title: shop, url: "https://acme.example/support", els: () => [T("Choose an amount"), at("Image", "", 100, 400)], label: "Next", btn: { x: 250, y: 400, w: 80, h: 30 } }, "refused"],
  [{ name: "Slack in-app upgrade dialog, Continue", title: "Slack | #general | M&U - Google Chrome", url: "https://app.slack.com/client/T1/C1", els: () => [T("Slack Pro"), T("A$12.75 per person/month"), T("Total A$25.50")], label: "Continue" }, "refused"],
  [{ name: "Discord Nitro gift inside a chat, 'Send'", title: "Discord | #general | Friends - Google Chrome", url: "https://discord.com/channels/1/2", els: () => [T("Gift Nitro"), T("A$14.99")], label: "Send" }, "asked → PRESSED after yes"], // (static text in a chat: asked as a final press; a gift tile or dialog is refused, section 1)
  [{ name: "Gmail with an embedded pay dialog, 'Send'", title: "Inbox - Gmail - Google Chrome", url: "https://mail.google.com/mail/u/0/", els: () => [T("Send money with Google Pay"), T("A$50.00")], label: "Send" }, "asked → PRESSED after yes"], // (as above)
  [{ name: "step flow with progress bar only (no step text), Continue", title: shop, url: "https://acme.example/p", els: () => [el("ProgressBar", "", { value: "75" }), el("Document", "")], label: "Continue" }, "refused"],
  [{ name: "unlabelled icon button next to 'Total A$49.99'", title: shop, url: "https://acme.example/p", els: () => [at("Text", "Total A$49.99", 100, 500)], label: "", btn: { x: 250, y: 500, w: 40, h: 30 } }, "not pressed"],
  [{ name: "'›' icon near split total", title: shop, url: "https://acme.example/p", els: () => [at("Text", "Total", 100, 500), at("Text", "A$49.99", 200, 500)], label: "›", btn: { x: 300, y: 500, w: 40, h: 30 } }, "not pressed"],
  [{ name: "Hyperlink 'Continue' (not a Button) with an amount", title: shop, url: "https://acme.example/p", els: () => [T("A$49.99")], label: "Continue", btnType: "Hyperlink" }, "refused"],
  [{ name: "ListItem tier 'Pro A$19/mo' (a choosing press)", title: shop, url: "https://acme.example/p", els: () => [T("Choose your plan")], label: "Pro A$19/mo", btnType: "ListItem" }, "refused"],
];

describe("the reviewer's 15 R8 variants", () => {
  test("the list is the reviewer's (15)", () => expect(R8_CASES).toHaveLength(15));
  test.each(R8_CASES.map(([c, want]) => [c.name, c, want] as const))("%s", async (_n, c, want) => {
    expect({ name: c.name, out: await run(c) }).toEqual({ name: c.name, out: want });
  });
  test("away mode refuses every one of them", async () => {
    for (const [c] of R8_CASES.filter(([c]) => c.label && /\p{L}/u.test(c.label) && c.btnType !== "Hyperlink")) expect({ name: c.name, out: await run({ ...c, unattended: true }) }).toEqual({ name: c.name, out: "refused" });
  });
});

describe("1. the amount-box rule inside mail and chat: choosable amounts and dialogs, never message text", () => {
  const chats: Array<[string, string, string[]]> = [
    ["Discord | #general - Google Chrome", "https://discord.com/channels/1/2", ["Gift Nitro", "A$14.99"]],
    ["Inbox - Gmail - Google Chrome", "https://mail.google.com/mail/u/0/", ["Send money with Google Pay", "A$50.00"]],
    ["Slack | #general - Google Chrome", "https://app.slack.com/client/T1/C1", ["Send a payment", "$25.00"]],
    ["WhatsApp - Google Chrome", "https://web.whatsapp.com/", ["Pagar", "R$ 50,00"]],
  ];
  test.each(chats)("%s: Send with the amount on a choosable tile beside it is REFUSED", async (title, url, lines) => {
    expect(await run({ name: title, title, url, els: () => [at("Text", lines[0], 500, 300), at("RadioButton", lines[1], 500, 340)], label: "Send", btn: { x: 520, y: 400, w: 80, h: 30 } })).toBe("refused");
  });
  test.each(chats)("%s: Send inside a pay or gift dialog (a Window box) showing the amount is REFUSED", async (title, url, lines) => {
    const dialog = at("Window", lines[0], 450, 250, 500, 250);
    expect(await run({ name: title, title, url, els: () => [at("Text", lines[0], 500, 300), at("Text", lines[1], 500, 340)], label: "Send", btn: { x: 520, y: 400, w: 80, h: 30 }, boxes: [dialog] })).toBe("refused");
  });
  test("R8 review OK5: an invoice email draft with 'Amount due' | 'A$825.00' cells, Send: asked, not refused", async () => {
    const out = await run({ name: "OK5", title: "Invoice INV-0043 - Gmail - Google Chrome", url: "https://mail.google.com/mail/u/0/#inbox?compose=new", els: () => [at("Text", "Hi Bianca, invoice attached.", 500, 300), at("Text", "Amount due", 500, 340), at("Text", "A$825.00", 650, 340)], label: "Send", btn: { x: 500, y: 420, w: 80, h: 30 }, boxes: [at("Pane", "New Message", 450, 250, 600, 250)] });
    expect(out).toBe("asked → PRESSED after yes");
  });
  test("…and the same draft inside a compose dialog (a Window) whose body is an editable Document: still asked", async () => {
    const out = await run({ name: "OK5w", title: "Invoice INV-0043 - Gmail - Google Chrome", url: "https://mail.google.com/mail/u/0/#inbox?compose=new", els: () => [at("Document", "Message Body", 460, 280, 560, 110), at("Text", "Amount due", 500, 340), at("Text", "A$825.00", 650, 340)], label: "Send", btn: { x: 500, y: 420, w: 80, h: 30 }, boxes: [at("Window", "New Message", 450, 250, 600, 250)] });
    expect(out).toBe("asked → PRESSED after yes");
  });
  test("R8 review OK6: a friend's '$20' bubble beside Send in WhatsApp: asked, not refused", async () => {
    const out = await run({ name: "OK6", title: "WhatsApp - Google Chrome", url: "https://web.whatsapp.com/", els: () => [at("Text", "Lunch was", 500, 300), at("Text", "$20", 500, 340)], label: "Send", btn: { x: 520, y: 400, w: 80, h: 30 } });
    expect(out).toBe("asked → PRESSED after yes");
  });
  test("a message that merely mentions an amount near Send is not a box (asked as a final press, as before)", async () => {
    const out = await run({ name: "gmail", title: "Invoice INV-0043 - Gmail - Google Chrome", url: "https://mail.google.com/mail/u/0/#inbox/x", els: () => [at("Text", "Total A$825.00 due 30 Oct", 500, 300), at("Text", "Thanks Usman, invoice attached.", 500, 340)], label: "Send", btn: { x: 520, y: 400, w: 80, h: 30 } });
    expect(out).toBe("asked → PRESSED after yes");
  });
  test("amountOnly: a price tag, not a sentence", () => {
    for (const l of ["A$14.99", "$5", "2,00 €", "₹499", "US$ 9.99", "Rp 150.000", "R$ 50,00", "A$4.99/mo"]) expect({ l, a: amountOnly(l) }).toEqual({ l, a: true });
    for (const l of ["Total A$825.00 due 30 Oct", "5 people", "Step 2", "2024", "Gift Nitro", ""]) expect({ l, a: amountOnly(l) }).toEqual({ l, a: false });
  });
});

describe("2. amount boxes: the control's dialog AND the old radius (never narrower than before)", () => {
  const box = (x: number, y: number, w: number, h: number) => at("Pane", "", x, y, w, h);
  test("the amount 600 px from Send inside the same dialog: REFUSED", async () => {
    const dialog = box(80, 250, 700, 750);
    expect(await run({ name: "far in box", title: shop, url: "https://acme.example/post/1", els: () => [at("Text", "Thanks for supporting", 100, 280), at("Text", "A$3.00", 100, 900)], label: "Send", btn: { x: 120, y: 300, w: 80, h: 30 }, boxes: [dialog] })).toBe("refused");
  });
  test("a gift-a-sub box laid out wide (1100 px apart) is REFUSED when the dialog holds both", async () => {
    const dialog = box(50, 200, 1300, 300);
    expect(await run({ name: "gift", title: "creator - Twitch - Google Chrome", url: "https://www.twitch.tv/creator", els: () => [at("Text", "Gift a sub", 60, 220), at("Text", "A$7.99", 80, 260)], label: "Next", btn: { x: 1200, y: 420, w: 80, h: 30 }, boxes: [dialog] })).toBe("refused");
  });
  test("R8 review BOX1: Send in a small button group, 'A$3.00' 150 px away in the tip dialog: REFUSED (as at base)", async () => {
    expect(await run({ name: "BOX1", title: shop, url: "https://acme.example/post/1", els: () => [at("Text", "Say thanks", 100, 400), at("Text", "A$3.00", 150, 450)], label: "Send", btn: { x: 400, y: 450, w: 80, h: 30 }, boxes: [at("Pane", "Tip dialog", 80, 380, 600, 200), at("Group", "", 300, 440, 200, 50)] })).toBe("refused");
  });
  test("R8 review BOX2: Next in a footer group, 'A$7.99' 100 px above: REFUSED (as at base)", async () => {
    expect(await run({ name: "BOX2", title: "creator - Twitch - Google Chrome", url: "https://www.twitch.tv/creator", els: () => [at("Text", "Gift a sub", 100, 300), at("Text", "A$7.99", 400, 350)], label: "Next", btn: { x: 400, y: 450, w: 80, h: 30 }, boxes: [at("Pane", "", 80, 280, 700, 260), at("Group", "", 380, 440, 250, 50)] })).toBe("refused");
  });
  test("an amount beside the button but in another card is still seen (the radius always counts): REFUSED", async () => {
    const card = box(600, 280, 300, 200);
    expect(await run({ name: "other card", title: shop, url: "https://acme.example/p", els: () => [at("Text", "A$3.00", 450, 300)], label: "Send", btn: { x: 620, y: 300, w: 80, h: 30 }, boxes: [card] })).toBe("refused");
  });
  test("nearbyOf is the union of the radius and the largest dialog holding the control", () => {
    const b = at("Button", "Send", 620, 300);
    const small = at("Group", "", 600, 290, 200, 50);
    const dialog = at("Window", "Tip", 400, 100, 900, 1000);
    const far = at("Text", "A$9.00", 450, 1000);
    const near = at("Text", "A$3.00", 450, 300);
    const outside = at("Text", "A$1.00", 100, 1050);
    expect(nearbyTextOf(b, [near, far, outside, b], [small, dialog]).split("\n")).toEqual(["A$3.00", "A$9.00"]);
    expect(dialogOf(b, [small, dialog])).toBe(dialog);
    expect(containerOf(b, [dialog, small])).toBe(small);
  });
  test("parseSnapshot reads the helper's container rows (B) into boxes and a T row as truncated", () => {
    const s = parseSnapshot(["W\t0\t0\t1400\t1000", "E\t0\tButton\t620\t300\t80\t30\teI\tSend\t\t\t", "B\t-1\tPane\t600\t280\t300\t200\te\tTip dialog\t\t\t"].join("\n"));
    expect(s.elements.map((e) => e.name)).toEqual(["Send"]);
    expect(s.boxes?.map((b) => [b.type, b.name, b.x, b.w])).toEqual([["Pane", "Tip dialog", 600, 300]]);
    expect(s.truncated).toBeUndefined();
    expect(parseSnapshot("W\t0\t0\t10\t10\nT\t300\t12\t140").truncated).toBe(true);
  });
  test("the helper reads context only around commit-type controls, only for browsers, under a whole-call deadline", () => {
    const helper = SCREEN_PRELUDE.join("\n");
    expect(helper).toContain("SnapshotX(long handle, int max, bool context)");
    expect(helper).toMatch(/if \(clock\.ElapsedMilliseconds > deadline\) \{ truncated = true; break; \}/);
    expect(helper).toContain("CommitName(");
    expect(helper).toContain('sb.Append("T"');
    expect(helper).not.toMatch(/root\.FindAll\(TreeScope\.Descendants, new AndCondition\(on, AnyOf\(ContextKinds\)\)\)/);
  });
  test("a truncated context read: a commit press with no money seen is asked when he's there, refused when he isn't", () => {
    const ctx = { focused: null, browser: true, deny: true, window: { handle: 7, process: "chrome", cls: "x", title: "Big page - Google Chrome" } as never, dialogText: "Big page", url: "https://acme.example/big", truncated: true };
    expect(vetAction({ do: "click", element: at("Button", "Continue", 500, 500) }, ctx)).toMatchObject({ ok: false, confirm: "Continue" });
    expect(vetAction({ do: "click", element: at("Button", "Continue", 500, 500) }, { ...ctx, confirmed: "Continue" })).toEqual({ ok: true });
    expect(vetAction({ do: "click", element: at("Button", "Continue", 500, 500) }, { ...ctx, unattended: true })).toMatchObject({ ok: false, refused: true });
    // A reading press is unaffected.
    expect(vetAction({ do: "click", element: at("Button", "Show more", 500, 500) }, ctx)).toEqual({ ok: true });
  });
});

describe("3. amount prompts, progress bars and amount pickers", () => {
  const PROMPTS = ["Choose an amount", "Select amount", "Enter a custom amount", "Other amount", "How much would you like to give?", "Choisissez un montant", "Betrag wählen", "Elige un monto", "Scegli l'importo", "Kies een bedrag", "Välj belopp", "Wybierz kwotę", "Pilih nominal", "金額を選択", "选择金额", "금액 선택"];
  test.each(PROMPTS)("%p with a committing press is a payment step (no amount readable)", (prompt) => {
    expect(moneyContextLevel({ title: "Support - Google Chrome", url: "https://creator.example/support", text: `Support\n${prompt}`, process: "chrome", commit: true })?.level).toBe("transactional");
    expect(moneyContextLevel({ title: "Support - Google Chrome", url: "https://creator.example/support", text: `Support\n${prompt}`, process: "chrome", commit: false })).toBeNull();
  });
  test("a progress bar plus a frame is a step; a progress bar alone (a video, an upload) isn't", () => {
    const base = { title: "Acme", url: "https://acme.example/p", text: "Acme", process: "chrome", commit: true };
    expect(moneyContextLevel({ ...base, embeds: true, progress: true })?.level).toBe("transactional");
    expect(moneyContextLevel({ ...base, embeds: false, progress: true })).toBeNull();
  });
  test("amount pickers: choosable controls named only by an amount (not price-filter checkboxes)", () => {
    expect(amountPickerOf([at("RadioButton", "$5", 0, 0), at("RadioButton", "$10", 0, 0)])).toBe(true);
    expect(amountPickerOf([at("Image", "A$20", 0, 0)])).toBe(true);
    expect(amountPickerOf([at("RadioButton", "Small", 0, 0), at("Button", "Next", 0, 0), at("Text", "$5", 0, 0)])).toBe(false);
    expect(amountPickerOf([at("CheckBox", "$0 - $50", 0, 0), at("CheckBox", "$50 - $100", 0, 0)])).toBe(false);
  });
  test("R8 review OK7: 'Submit review' on a search page with '$0 - $50' filter checkboxes: asked, not refused", async () => {
    const out = await run({ name: "OK7", title: "Headphones - Acme - Google Chrome", url: "https://shop.acme.example/search?q=headphones", els: () => [el("CheckBox", "$0 - $50"), el("CheckBox", "$50 - $100"), el("Edit", "Your review")], label: "Submit review" });
    expect(out).toBe("asked → PRESSED after yes");
  });
  test("an amount picker far from the pressed control (no box) doesn't make it a picker page", async () => {
    const out = await run({ name: "far picker", title: shop, url: "https://acme.example/p", els: () => [at("RadioButton", "$5", 100, 1200)], label: "Next", btn: { x: 100, y: 200, w: 80, h: 30 } });
    expect(out).not.toBe("refused");
  });
});

// ---------------------------------------------------------------------------------------------------------
const OWNER = "8550678495";
type PageSpec = { title: string; url: string; texts: string[]; button: string };
function away(spec: PageSpec, options: { hosts?: string[]; payees?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), "away-r8-"));
  const log: string[] = [];
  const st = { title: spec.title, elements: [address(spec.url), ...spec.texts.map((t) => T(t)), el("Button", spec.button)] };
  const win = () => ({ handle: 21, process: "chrome", cls: "Chrome_WidgetWin_1", title: st.title });
  const hands: Hands = {
    foreground: async () => win(), windows: async () => [win()], focus: async () => true,
    snapshot: async () => ({ window: { x: 0, y: 0, w: 1400, h: 800 }, elements: st.elements, focused: null, browser: true }),
    focused: async () => null, at: async () => null, click: async () => void log.push("click"),
    press: async (_h, e) => {
      log.push(`press ${e.name}`);
      st.title = "Payment received - Google Chrome";
      st.elements = [address(spec.url), T("Thank you for your payment"), T("Reference TX12345")];
      return "uia";
    },
    type: async (_h, t) => void log.push(`type ${t}`), keys: async (_h, k) => void log.push(`keys ${k}`), wheel: async () => void log.push("wheel"), capture: async () => null,
  };
  const real = createScreenHands({ key: () => "", hands, flags: () => ({ ...FLAGS_OFF, denylist: true }), audit: null, jarvisChrome: null });
  const sentinel = { running: true, async start() { return true; }, stop() {}, async locked() { return false; }, async idleMs() { return 60_000; }, async shot() { return false; }, onInput() { return () => {}; } };
  const mode = createAwayMode({
    store: stateStore(join(dir, "state")), audit: auditLog(join(dir, "data")), sentinel: sentinel as never,
    notify: async () => ({ ok: true, detail: "sent" }),
    screen: { act: (req, s) => real.act(req, s), stopAll: () => 0, flags: () => ({ denylist: true }), foreground: async () => win(), snapshot: async () => ({ window: { x: 0, y: 0, w: 1400, h: 800 }, elements: st.elements, focused: null, browser: true }), windows: async () => [win()], focus: async () => true },
    hermes: async () => "ok", cli: async () => ({ ok: true, output: "ok" }),
    files: { exists: () => false, mkdir: async () => {}, write: async () => {}, recycle: async () => {} },
    launch: async (app: string) => ({ ok: true, said: `${app} is opening.` }),
    ownerChat: () => OWNER, home: "C:\\Users\\Nebula PC", code: () => "7F3K", sleep: async () => undefined,
    config: { tickMs: 1e9, approvalTtlMs: 30 * 60_000, armIdleMs: 15_000, launchWaitMs: 1000, payments: true, paymentHosts: options.hosts ?? [], savedPayees: options.payees ?? [] },
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
  return { mode, msg, settle, last: () => mode.status().tasks.at(-1)!, presses: () => log.filter((l) => /^(?:press|click)\b/.test(l)), close: () => (mode.close(), rmSync(dir, { recursive: true, force: true })) };
}

describe("4. the R5 allowlist-abuse set against the current payment runner (payments ON, host registered)", () => {
  const ABUSE: Array<[string, string, PageSpec, { hosts: string[]; payees?: string[] }]> = [
    ["P2P PayPal to an unsaved person", "pay the PayPal bill: open Chrome, click Pay", { title: "PayPal - Google Chrome", url: "https://www.paypal.com/myaccount/transfer/homepage/pay", texts: ["Paying: Sam Smith", "Amount A$500.00"], button: "Pay" }, { hosts: ["paypal.com"] }],
    ["P2P Wise to an unsaved person", "pay the Wise invoice: open Chrome, click Confirm and send", { title: "Review details - Wise - Google Chrome", url: "https://wise.com/send/review", texts: ["Recipient: Sam Smith", "You send A$500.00"], button: "Confirm and send" }, { hosts: ["wise.com"] }],
    ["P2P Beem to an unsaved person", "pay Zaid's invoice: open Chrome, click Pay", { title: "Beem - Google Chrome", url: "https://app.beem.com.au/pay", texts: ["Pay to: Zaid Ahmed", "Amount A$60.00"], button: "Pay" }, { hosts: ["beem.com.au"] }],
    ["two payees (Telstra over the real recipient)", "pay the Telstra invoice: open Chrome, click Send Now", { title: "Send money - PayPal - Google Chrome", url: "https://www.paypal.com/myaccount/transfer/send", texts: ["Paying: Telstra", "Recipient email: refunds@telstra-billing.example", "Amount A$500.00"], button: "Send Now" }, { hosts: ["paypal.com"], payees: ["Telstra"] }],
    ["Cyrillic lookalike of a saved payee", "pay my saved payee Mehroz: open Chrome, click Pay", { title: "Pay anyone - NetBank - Google Chrome", url: "https://www.my.commbank.com.au/netbank/pay", texts: ["Payee: Меhrоz Khаn", "Amount $500.00"], button: "Pay" }, { hosts: ["commbank.com.au"], payees: ["Mehroz Khan"] }],
    ["public suffix 'com.au' on the list", "buy the monitor: open Chrome, click Pay", { title: "Checkout - DodgyShop - Google Chrome", url: "https://www.dodgyshop.com.au/checkout", texts: ["Merchant: DodgyShop", "Total A$899.00"], button: "Pay" }, { hosts: ["com.au"] }],
    ["shared host 'vercel.app' on the list", "pay my Telstra bill: open Chrome, click Pay", { title: "Telstra Bill - Google Chrome", url: "https://telstra-pay-bill.vercel.app/pay", texts: ["Payee: Telstra", "Amount due A$123.45"], button: "Pay" }, { hosts: ["vercel.app"] }],
    ["a draw entry (art union)", "buy the draw entry: open Chrome, click Enter now", { title: "Prize Home Draw - RSL Art Union - Google Chrome", url: "https://www.rslartunion.com.au/buy", texts: ["3 entries", "Total A$30.00"], button: "Enter now" }, { hosts: ["rslartunion.com.au"] }],
    ["a raffle", "get me 3 raffle tickets: open Chrome, click Buy", { title: "Raffle - Charity - Google Chrome", url: "https://www.charity.example/raffle", texts: ["3 tickets", "Total A$15.00"], button: "Buy" }, { hosts: ["charity.example"] }],
    ["crypto voucher on a registered shop (Amazon)", "buy the voucher on Amazon: open Chrome, click Place your order", { title: "Checkout - Amazon.com.au - Google Chrome", url: "https://www.amazon.com.au/gp/buy/spc", texts: ["Bitaroo digital voucher", "Order total A$500.00"], button: "Place your order" }, { hosts: ["amazon.com.au"] }],
    ["betting voucher on a registered shop", "buy the gift card on Amazon: open Chrome, click Place your order", { title: "Checkout - Amazon.com.au - Google Chrome", url: "https://www.amazon.com.au/gp/buy/spc", texts: ["Sportsbet gift card", "Order total A$100.00"], button: "Place your order" }, { hosts: ["amazon.com.au"] }],
  ];
  test.each(ABUSE)("%s: refused, no code asked, nothing pressed", async (_what, task, spec, opts) => {
    const h = away(spec, opts);
    try {
      await h.msg("/away on");
      await h.msg(`/task ${task}`);
      await h.settle();
      expect({ task, status: h.last().status, pending: h.mode.status().pending, presses: h.presses() }).toEqual({ task, status: "refused", pending: null, presses: [] });
    } finally {
      h.close();
    }
  });
  test("control: a bill on a registered host with nothing wrong is still asked for the code (the runner works)", async () => {
    const h = away({ title: "Your bill - Telstra - Google Chrome", url: "https://www.telstra.com.au/my-account/bills/pay", texts: ["Amount due A$123.45", "Paying: Telstra"], button: "Make payment" }, { hosts: ["telstra.com.au"] });
    try {
      await h.msg("/away on");
      await h.msg("/task pay my Telstra bill: open Chrome, click Make payment");
      await h.settle();
      expect(h.last().status).toBe("awaiting_approval");
      expect(h.presses()).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("the overlay stays off under bun test, even when NODE_ENV was set by the parent (R8 review §6)", () => {
  test("underTest: NODE_ENV=test, or a test file as the entry point", async () => {
    const { underTest } = await import("./screen-hands/overlay");
    expect(underTest({ NODE_ENV: "test" }, "C:/x/app.ts")).toBe(true);
    expect(underTest({ NODE_ENV: "development" }, "C:/x/scripts/safety-review-r8.test.ts")).toBe(true);
    expect(underTest({ NODE_ENV: "development" }, "D:/p/thing.spec.tsx")).toBe(true);
    expect(underTest({ NODE_ENV: "development" }, "C:/x/scripts/operator-plugin.ts")).toBe(false);
    expect(underTest({}, "")).toBe(false);
    // This very run is a test.
    expect(underTest()).toBe(true);
  });
});

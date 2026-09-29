// S2c (28 Sep, REVIEW-T1 required fix 1): a Jarvis Chrome click on a final or commit button (send, submit,
// delete, post, publish, pay, place order, confirm…) never happens without his spoken yes to that exact
// button. The voice turn (spoken and typed in a session share it) routes such a click to screen_act, the
// gated path; /browser/act refuses final buttons itself; a typed yes never mints the spoken-yes the press
// needs. Non-final clicks (links, videos, "next page") are unchanged. SYNTHETIC: fake fetch, no browser.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalButtonText, finalClickRefusal } from "./browser-hands";
import { finalClickToScreen, freeVoice, guardToolCall } from "./free-voice";
import { SpokenConfirmationLedger } from "./jarvis-execution/voice-confirmation";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
  }
});

const FINAL_REQUESTS = [
  "press send", "click send", "click submit", "click delete", "click post", "press the publish button", "click publish",
  "click confirm", "press the place order button", "click pay now", "click buy now", "click book now", "press remove",
];
const ORDINARY_REQUESTS = ["click next page", "click the first video", "click sign in", "click show more", "press reply", "click load more"];

describe("the shared final-button classification (action-keywords FINAL_BUTTON + money-policy moneyButton)", () => {
  test.each(["Send", "Submit", "Delete", "Post", "Publish", "Pay now", "Place order", "Confirm", "Buy now", "Book now", "Remove", "Unsubscribe", "Accept"])(
    "%p is final",
    (label) => expect(finalButtonText(label)).toBe(true),
  );
  test.each(["Next page", "Sign in", "Show more", "Reply", "Download PDF", "Load more", "Next", "Continue reading", ""])("%p is not", (label) =>
    expect(finalButtonText(label)).toBe(false),
  );
  test("the click the words land on is checked too, but a video title isn't a button", () => {
    expect(finalClickRefusal({ kind: "button", label: "Delete" }, "the third button")).toMatch(/Nothing was pressed/);
    expect(finalClickRefusal({ kind: "link", label: "Publish" }, "the second link")).toMatch(/Nothing was pressed/);
    expect(finalClickRefusal({ kind: "video", label: "How to delete your account in 2 minutes" }, "the first video")).toBeNull();
    expect(finalClickRefusal({ kind: "link", label: "Next page" }, "next page")).toBeNull();
    expect(finalClickRefusal(null, "the publish button")).toMatch(/"publish"/);
  });
  test("/browser/act checks before it clicks (named, then landed-on), never after", () => {
    const source = readFileSync(join(import.meta.dir, "browser-hands.ts"), "utf8");
    const clickCase = source.slice(source.indexOf('case "click": {'), source.indexOf("return done(true, `Clicked"));
    expect(clickCase.indexOf("finalClickRefusal(null")).toBeGreaterThan(0);
    expect(clickCase.indexOf("finalClickRefusal(hit")).toBeGreaterThan(clickCase.indexOf("finalClickRefusal(null"));
    expect(clickCase.indexOf("await click(s, hit.x, hit.y)")).toBeGreaterThan(clickCase.indexOf("finalClickRefusal(hit"));
  });
});

function voiceOffline(jarvisChromeInFront = true) {
  const d = mkdtempSync(join(tmpdir(), "s2c-voice-"));
  dirs.push(d);
  const calls: string[] = [];
  const voice = freeVoice(d, {
    key: (name: string) => (name === "GROQ_API_KEY" ? "synthetic" : ""),
    jarvisChromeInFront: async () => jarvisChromeInFront,
    fetch: (async (url: string) => (calls.push(String(url)), new Response(JSON.stringify({ choices: [{ message: { content: "brain" } }] }), { status: 200 }))) as typeof fetch,
  } as any);
  return { voice, calls };
}
const firstCall = (r: any) => ({ name: r?.tool_calls?.[0]?.function.name, args: JSON.parse(r?.tool_calls?.[0]?.function.arguments ?? "{}") });

describe("the voice turn (spoken, and typed in a session: the same /voice/free/turn) with Jarvis Chrome in front", () => {
  test.each(FINAL_REQUESTS)("%p → screen_act (asks first), never a direct browser click", async (utterance) => {
    const { voice } = voiceOffline(true);
    const result: any = await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: utterance }] });
    const call = firstCall(result);
    expect(call.name).not.toBe("browser_act");
    if (call.name) expect(call.name).toBe("screen_act");
    expect(call.args.confirmed).toBeUndefined();
  });
  test.each(ORDINARY_REQUESTS)("%p stays a direct browser click", async (utterance) => {
    const { voice } = voiceOffline(true);
    const call = firstCall(await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: utterance }] }));
    // (J2: a named, non-final control is the agent-browser hands' click, through the same S2c/S2e gates; a pointer like
    // "the first video" is a step for the J6 browser task loop, on Jarvis Chrome: still a direct browser act, never screen_act.)
    expect(call).toMatchObject(/first|second|third|last/.test(utterance) ? { name: "skill", args: { skill: "browser", action: "task_here" } } : { name: "skill", args: { skill: "browser", action: "click" } });
  });
});

describe("a browser_act click chosen by Jev or the brain", () => {
  const call = (args: Record<string, unknown>) => ({ id: "b1", type: "function" as const, function: { name: "browser_act", arguments: JSON.stringify(args) } });
  test.each(["send", "Submit", "delete", "the publish button", "place order", "confirm"])("%p becomes screen_act on that button", (target) => {
    const out = guardToolCall(call({ action: "click", target }), "go ahead");
    expect(out.function.name).toBe("screen_act");
    expect(JSON.parse(out.function.arguments)).toEqual({ goal: `press ${target}` });
    expect(finalClickToScreen(call({ action: "click", target })).function.name).toBe("screen_act");
  });
  test.each(["the first video", "next page", "sign in"])("%p is untouched", (target) => {
    expect(finalClickToScreen(call({ action: "click", target })).function.name).toBe("browser_act");
  });
  test("pause, play and search are untouched", () => {
    for (const action of ["pause", "play", "search"]) expect(finalClickToScreen(call({ action, target: "send" })).function.name).toBe("browser_act");
  });
});

describe("typed input never satisfies the press", () => {
  test("a typed 'yes' after 'Shall I press Send?' mints no spoken yes, so the server presses nothing", async () => {
    const ledger = new SpokenConfirmationLedger();
    const asked = ledger.ask("screen");
    // A typed turn never calls record(): only the voice pipeline's own STT does. With no event id, redeem fails.
    expect(ledger.redeem(undefined, { after: asked.at, question: asked.id })).toBeNull();
    expect(ledger.redeem("typed-yes", { after: asked.at, question: asked.id })).toBeNull();
    // A spoken whole-utterance yes is the only thing that can.
    const spoken = ledger.record("yes");
    expect(spoken).not.toBeNull();
    // ...and "okay, send it to Mehroz" or "press send" said again is not a yes.
    expect(new SpokenConfirmationLedger().record("okay, send it to Mehroz")).toBeNull();
  });
  test("the typed turn's confirmed re-send carries no spokenYes, and the client refuses a final press without one", () => {
    const client = readFileSync(join(import.meta.dir, "..", "src", "components", "operator", "voice-companion.tsx"), "utf8");
    expect(client).toContain('if (!spokenYes) return "A final button needs your spoken yes');
  });
});

// --- REVIEW-S2C fixes ---------------------------------------------------------------------------------------
import { candidateNames, isSearchField, moneyClickRefusal, type PageMoneyContext } from "./browser-hands";
import { FINAL_BUTTON } from "../src/lib/action-keywords";

describe("REVIEW-S2C fix 2: final buttons in other languages (the shared FINAL_BUTTON, so the screen path gets them too)", () => {
  test.each([
    "Envoyer", "Senden", "Absenden", "إرسال", "Supprimer", "Löschen", "送信", "Enviar", "Publier", "Veröffentlichen", "削除", "发送", "删除",
    "Invia", "Elimina", "Pubblica", "Excluir", "Verzenden", "Verwijderen", "보내기", "삭제", "제출", "भेजें", "हटाएं", "بھیجیں", "حذف", "投稿", "提交",
  ])("%p is final", (label) => {
    expect(FINAL_BUTTON.test(label)).toBe(true);
    expect(finalButtonText(label)).toBe(true);
  });
  test.each(["Suivant", "Weiter", "Rechercher", "Continuer la lecture", "Mehr anzeigen", "Anmelden", "Descargar", "確認", "확인", "OK", "게시판", "Postal code", "Entfernung", "Submarine"])(
    "%p is not",
    (label) => expect(finalButtonText(label)).toBe(false),
  );
});

describe("REVIEW-S2C fixes 1 and 3: every name the control has, and unnamed buttons", () => {
  test.each([
    [{ kind: "button" as const, label: "More options", names: ["Post", "More options"] }, "click more options"],
    [{ kind: "button" as const, label: "Next", names: ["Delete", "Next"] }, "click next"],
    [{ kind: "button" as const, label: "Delete this conversation and every message in it, permanently, for everyone", names: [] }, "the third button"],
    [{ kind: "button" as const, label: "Options", names: ["Options", "Envoyer"] }, "the first button"],
    [{ kind: "link" as const, label: "Publish", names: ["Publish"] }, "the second link"],
  ])("%j via %p is refused", (hit, target) => expect(finalClickRefusal(hit, target)).toMatch(/Nothing was pressed/));
  test("an unnamed button could be a final press: refused; an unnamed link is not a button", () => {
    expect(finalClickRefusal({ kind: "button", label: "", names: [] }, "the last button")).toMatch(/no name I can read/);
    expect(finalClickRefusal({ kind: "button", label: "", names: [] }, "this")).toMatch(/no name I can read/);
    expect(finalClickRefusal({ kind: "link", label: "", names: [] }, "the first link")).toBeNull();
  });
  test("ordinary controls with several names still pass", () => {
    expect(finalClickRefusal({ kind: "button", label: "Next", names: ["Next", "Go to the next page"] }, "next")).toBeNull();
    expect(finalClickRefusal({ kind: "video", label: "How to delete your account", names: ["How to delete your account", "Delete"] }, "the first video")).toBeNull();
    expect(candidateNames({ label: " Next ", names: ["Next", "", "Go on"] })).toEqual(["Next", "Go on"]);
  });
});

describe("REVIEW-S2C fix 4: a committing press on a money page (P's moneyContextLevel, as the screen path uses it)", () => {
  const page = (over: Partial<PageMoneyContext> = {}): PageMoneyContext => ({
    title: "Your order", url: "https://shop.example.com/things", text: "Your order\nOrder total: A$49.00\nContinue\nOK", nearby: "Order total: A$49.00\nContinue\nOK",
    controls: "Continue\nOK", embeds: false, progress: false, ...over,
  });
  test.each(["Continue", "OK", "Next", "Confirm", ""])("%p on a page showing a total is not pressed", (label) => {
    expect(moneyClickRefusal({ kind: "button", label, names: label ? [label] : [] }, page())).toMatch(/Nothing was pressed/);
  });
  test("an amount merely mentioned asks for his spoken yes; an ordinary press there is untouched", () => {
    const mention = page({ title: "Blog", url: "https://blog.example.com/post", text: "Blog\nWe raised our price to A$49.00 last week.", nearby: "Continue", controls: "Continue" });
    expect(moneyClickRefusal({ kind: "button", label: "Continue", names: ["Continue"] }, mention)).toMatch(/spoken yes/);
    expect(moneyClickRefusal({ kind: "button", label: "Show more", names: ["Show more"] }, page())).toBeNull();
    expect(moneyClickRefusal({ kind: "link", label: "Next page", names: ["Next page"] }, page())).toBeNull();
  });
  test("no money on the page: Continue and OK are ordinary", () => {
    const plain = page({ title: "Settings", text: "Settings\nTheme\nContinue", nearby: "Continue", controls: "Continue" });
    expect(moneyClickRefusal({ kind: "button", label: "Continue", names: ["Continue"] }, plain)).toBeNull();
  });
  test("/browser/act reads the page context and checks it before the click", () => {
    const source = readFileSync(join(import.meta.dir, "browser-hands.ts"), "utf8");
    const clickCase = source.slice(source.indexOf('case "click": {'), source.indexOf("return done(true, `Clicked"));
    expect(clickCase.indexOf("moneyClickRefusal(hit, around)")).toBeGreaterThan(clickCase.indexOf("finalClickRefusal(hit"));
    expect(clickCase.indexOf("await click(s, hit.x, hit.y)")).toBeGreaterThan(clickCase.indexOf("moneyClickRefusal(hit, around)"));
  });
});

describe("REVIEW-S2C fix 5: the search action only types into a real search field", () => {
  test.each([
    [{ type: "search" }, true], [{ role: "searchbox" }, true], [{ inSearchRegion: true }, true], [{ name: "q" }, true], [{ name: "search_query" }, true],
    [{ label: "Search" }, true], [{ placeholder: "Search…" }, true], [{ label: "Search or write a comment" }, false], [{ placeholder: "Search or write a comment" }, false],
    [{ label: "Write a comment" }, false], [{ name: "msg" }, false], [{ label: "Comment", placeholder: "Search" }, false],
  ])("%j → %p", (field, want) => expect(isSearchField(field)).toBe(want));
});

describe("the voice turn routes a non-English final click to the gated path too", () => {
  test.each(["click envoyer", "click senden", "click supprimer", "press löschen"])("%p → screen_act", async (utterance) => {
    const { voice } = voiceOffline(true);
    const call = firstCall(await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: utterance }] }));
    expect(call.name).toBe("screen_act");
  });
});

// --- REVIEW-S2C R2 ----------------------------------------------------------------------------------------
import { tidyName } from "./browser-hands";
import { moneyContextLevel, ownDashboard, setOwnServerPort } from "../src/lib/money-policy";

describe("REVIEW-S2C R2 fix 1: names are normalised before the check (NFKC, no format characters, symbols-only is unnamed)", () => {
  test("full-width ＳＥＮＤ: refused by name and by ordinal", () => {
    expect(finalClickRefusal(null, "ＳＥＮＤ")).toMatch(/Nothing was pressed/);
    expect(finalClickRefusal({ kind: "button", label: "ＳＥＮＤ", names: ["ＳＥＮＤ"] }, "the first button")).toMatch(/Nothing was pressed/);
  });
  test("Del\u200Bete (zero-width space inside): refused", () => {
    expect(finalClickRefusal({ kind: "button", label: "Del\u200Bete", names: ["Del\u200Bete"] }, "the second button")).toMatch(/Nothing was pressed/);
    expect(finalClickRefusal(null, "del\u200Bete")).toMatch(/Nothing was pressed/);
  });
  test("Sub\u00ADmit (soft hyphen inside): refused", () => {
    expect(finalClickRefusal({ kind: "button", label: "Sub\u00ADmit", names: ["Sub\u00ADmit"] }, "the third button")).toMatch(/Nothing was pressed/);
  });
  test("emoji-only 🗑️ with no aria-label: unnamed, so refused", () => {
    expect(finalClickRefusal({ kind: "button", label: "🗑️", names: ["🗑️"] }, "the last button")).toMatch(/no name I can read/);
    expect(finalClickRefusal({ kind: "button", label: "➤", names: ["➤"] }, "this")).toMatch(/no name I can read/);
  });
  test("ordinary names are unaffected", () => {
    expect(tidyName(" Ｎｅｘｔ\u200B page ")).toBe("Next page");
    expect(finalClickRefusal({ kind: "button", label: "Ｎｅｘｔ", names: ["Ｎｅｘｔ"] }, "next")).toBeNull();
    expect(finalClickRefusal({ kind: "button", label: "Show more ▾", names: ["Show more ▾"] }, "show more")).toBeNull();
  });
  test("\"Effacer le filtre\", \"Borrar búsqueda\" and \"Valider\" are no longer final; \"Effacer\" and \"Borrar cuenta\" are", () => {
    for (const label of ["Effacer le filtre", "Borrar búsqueda", "Valider"]) expect(finalButtonText(label)).toBe(false);
    for (const label of ["Effacer", "Borrar cuenta", "Supprimer"]) expect(finalButtonText(label)).toBe(true);
  });
});

describe("REVIEW-S2C R2 fix 2: only his real dashboards are exempt from money context", () => {
  const checkout = (url: string): PageMoneyContext => ({
    title: "Checkout", url, text: "Checkout\nOrder total: A$49.00\nContinue", nearby: "Order total: A$49.00\nContinue", controls: "Continue", embeds: false, progress: false,
  });
  afterEach(() => setOwnServerPort(null));
  test.each(["https://bianca.muventures.com.au/checkout", "http://localhost:3000/checkout", "http://127.0.0.1:5173/checkout", "https://preview.muventures.com.au/order"])(
    "a \"continue\" on a checkout page with a total at %p is refused",
    (url) => {
      setOwnServerPort(8081);
      expect(ownDashboard(url)).toBe(false);
      expect(moneyClickRefusal({ kind: "button", label: "Continue", names: ["Continue"] }, checkout(url))).toMatch(/Nothing was pressed/);
    },
  );
  test("the AgenticOS server at the port it registered, and the receptionist dashboard, stay exempt", () => {
    setOwnServerPort(8081);
    expect(ownDashboard("http://127.0.0.1:8081/finance")).toBe(true);
    expect(ownDashboard("http://localhost:8081/receptionist")).toBe(true);
    expect(ownDashboard("https://mu-receptionist.vercel.app/payments")).toBe(true);
    expect(ownDashboard("http://127.0.0.1:8081/__operator/anything")).toBe(false);
    // Another port is another server: a preview copy or a dev site isn't his dashboard.
    expect(ownDashboard("http://127.0.0.1:4471/finance")).toBe(false);
    // The port it really got, not a fixed 8081.
    setOwnServerPort(4471);
    expect(ownDashboard("http://127.0.0.1:4471/finance")).toBe(true);
    expect(ownDashboard("http://127.0.0.1:8081/finance")).toBe(false);
  });
  test("before the server registers, only the start port (8081) is assumed; any other local port is not exempt", () => {
    setOwnServerPort(null);
    expect(ownDashboard("http://127.0.0.1:8081/finance")).toBe(true);
    expect(ownDashboard("http://localhost:5173/finance")).toBe(false);
    expect(moneyContextLevel({ url: "http://localhost:5173/checkout", text: "Order total: A$49.00", commit: true })).not.toBeNull();
  });
  test("his own marketing site's apex stays his; its subdomains (client builds, previews) don't", () => {
    expect(ownDashboard("https://muventures.com.au/pricing")).toBe(true);
    expect(ownDashboard("https://www.muventures.com.au/pricing")).toBe(true);
    expect(ownDashboard("https://bianca.muventures.com.au/")).toBe(false);
    expect(ownDashboard("https://bianca-preview.muventures.com.au/")).toBe(false);
  });
  test("lookalikes stay refused", () => {
    setOwnServerPort(8081);
    for (const url of ["https://muventures.com.au.evil.test/checkout", "https://localhost.evil.test/checkout", "https://evil-muventures.com.au/checkout", "https://user:pw@mu-receptionist.vercel.app/", "http://mu-receptionist.vercel.app/"])
      expect(ownDashboard(url)).toBe(false);
  });
  test("the server registers the port it actually listens on", () => {
    const plugin = readFileSync(join(import.meta.dir, "operator-plugin.ts"), "utf8");
    expect(plugin).toContain("setOwnServerPort(address.port)");
  });
});

// --- REVIEW-S2C R3 ----------------------------------------------------------------------------------------
import { hostileName, withoutMarks } from "./browser-hands";

describe("REVIEW-S2C R3: bidi reordering, combining marks and mixed-script homoglyphs", () => {
  const button = (label: string, names: string[] = [label]) => ({ kind: "button" as const, label, names });
  test("RLO + \"yap\" (drawn as \"pay\") is unnamed, so refused; checked before \p{Cf} is stripped", () => {
    const rlo = "\u202Eyap\u202C";
    expect(hostileName(rlo)).toBe(true);
    expect(tidyName(rlo)).toBe("");
    expect(finalClickRefusal(button(rlo), "the first button")).toMatch(/no name I can read/);
    // An honest aria-label beside it doesn't rescue the control.
    expect(finalClickRefusal(button("Next", [rlo, "Next"]), "next")).toMatch(/no name I can read/);
    // Both overrides count (R4: only RLO and LRO reorder letters inside a word).
    expect(finalClickRefusal(button("\u202DNext"), "the first button")).toMatch(/no name I can read/);
  });
  test("\"S̶e̶n̶d̶\" (combining strike) is final: the name without its marks is tested too", () => {
    const struck = "S\u0336e\u0336n\u0336d\u0336";
    expect(withoutMarks(struck)).toBe("Send");
    expect(finalButtonText(struck)).toBe(true);
    expect(finalClickRefusal(button(struck), "the second button")).toMatch(/Nothing was pressed/);
  });
  test.each([["D\u0435lete", "Cyrillic е"], ["\u0405end", "Cyrillic Ѕ"], ["\u03A1ost", "Greek Ρ"], ["Pay n\u043Ew", "Cyrillic о"]])(
    "%p (%s mixed into a Latin word) is unnamed, so refused",
    (label) => {
      expect(hostileName(label)).toBe(true);
      expect(finalClickRefusal(button(label), "the first button")).toMatch(/no name I can read/);
    },
  );
  test("non-regressions: Hindi stays final; pure Cyrillic, Valider and Effacer le filtre stay clickable", () => {
    for (const label of ["भेजें", "हटाएं", "Löschen", "Supprimer", "Enviar"]) expect(finalClickRefusal(button(label), "the first button")).toMatch(/Nothing was pressed/);
    for (const label of ["Далее", "Меню", "Ελληνικά", "Valider", "Effacer le filtre", "Next", "Café menu"]) {
      expect(hostileName(label)).toBe(false);
      expect(finalClickRefusal(button(label), "the first button")).toBeNull();
    }
    // Separate words in different scripts are fine; only a word that mixes them is a homoglyph.
    expect(hostileName("Menu Меню")).toBe(false);
  });
});

// --- REVIEW-S2C R4 ----------------------------------------------------------------------------------------
describe("REVIEW-S2C R4: trick names on links, and only the bidi overrides are hostile", () => {
  const link = (label: string, names: string[] = [label]) => ({ kind: "link" as const, label, names });
  const button = (label: string, names: string[] = [label]) => ({ kind: "button" as const, label, names });
  test("<a class=\"btn\"> with RLO + \"eteleD\" (displays \"Delete\") is refused", () => {
    expect(finalClickRefusal(link("\u202EeteleD\u202C"), "the first link")).toMatch(/Nothing was pressed/);
  });
  test("a link \"Dеlete account\" with a Cyrillic е is refused", () => {
    expect(finalClickRefusal(link("D\u0435lete account"), "the second link")).toMatch(/Nothing was pressed/);
  });
  test("a plain unnamed icon link, and ordinary links, stay clickable", () => {
    expect(finalClickRefusal(link("", []), "the first link")).toBeNull();
    expect(finalClickRefusal(link("🏠", ["🏠"]), "the first link")).toBeNull();
    expect(finalClickRefusal(link("Next page"), "next page")).toBeNull();
  });
  test("the reversed-text cases stay refused (RLO and LRO), on buttons and links", () => {
    for (const name of ["\u202Eyap\u202C", "\u202EeteleD\u202C", "\u202D\u0625\u0631\u0633\u0627\u0644\u202C", "\u202EPay\u202C"]) {
      expect(finalClickRefusal(button(name), "the first button")).toMatch(/Nothing was pressed/);
      expect(finalClickRefusal(link(name), "the first link")).toMatch(/Nothing was pressed/);
    }
  });
  test("marks, embeddings and isolates are only stripped: Gmail's \"Bold (Ctrl-B)\", Hebrew and Arabic labels are clickable", () => {
    expect(hostileName("Bold \u202A(Ctrl-B)\u202C")).toBe(false);
    expect(finalClickRefusal(button("B", ["B", "Bold \u202A(Ctrl-B)\u202C"]), "bold")).toBeNull();
    expect(finalClickRefusal(button("Italic \u2066(Ctrl-I)\u2069"), "italic")).toBeNull();
    expect(finalClickRefusal(button("\u05D4\u05D1\u05D0\u200F"), "the first button")).toBeNull(); // Hebrew "Next" + RLM
    expect(finalClickRefusal(button("\u0627\u0644\u062A\u0627\u0644\u064A\u061C"), "the first button")).toBeNull(); // Arabic "Next" + ALM
    // ...and a final word behind those marks is still final.
    expect(finalClickRefusal(button("\u200FSend\u200F"), "the first button")).toMatch(/Nothing was pressed/);
    expect(finalClickRefusal(button("\u2067\u0625\u0631\u0633\u0627\u0644\u2069"), "the first button")).toMatch(/Nothing was pressed/);
  });
  test.each(["Отправить", "Удалить", "Оплатить", "Подтвердить", "Купить", "Опубликовать", "ОТПРАВИТЬ"])("Russian %p is final", (label) => {
    expect(finalButtonText(label)).toBe(true);
    expect(finalClickRefusal(button(label), "the first button")).toMatch(/Nothing was pressed/);
  });
  test("Russian ordinary words stay clickable", () => {
    for (const label of ["Далее", "Меню", "Войти", "Показать ещё"]) expect(finalButtonText(label)).toBe(false);
  });
  test("Hindi can be named: vowel signs are kept when reading his words", () => {
    expect(finalClickRefusal(null, "भेजें")).toMatch(/Nothing was pressed/);
    expect(finalClickRefusal(null, "हटाएं")).toMatch(/Nothing was pressed/);
  });
});

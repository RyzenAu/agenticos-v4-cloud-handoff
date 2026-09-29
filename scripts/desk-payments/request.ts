// Desk payments: his OWN words (spoken or typed at the desk) read into a payment request. Pure; no I/O.
//
//   deskPayOrder    do these words order a payment, or press a pay button?  ("pay the Telstra bill", "pay this",
//                   "send Sam $50", "click pay now", "renew my domain", "donate 50 to Islamic Relief")
//   deskOpenOrder   do they only open a bank or payment site?  ("open my bank", "open CommBank", "go to paypal.com")
//   parseDeskRequest  who, how much, which site, what for; or the never kind (trade, crypto, bet, card details)
//
// Reading his words never presses anything. A request becomes a pending payment only after the page is read and he sees
// the confirm card (service.ts); the words are only ever his: a page, an email or a file can't reach this function.
import {
  cardNumberIn, institutionFor, moneyHostKind, moneyRefusal, MONEY_AMOUNT, normaliseText, paymentIntent, registrableDomain,
  type PaymentKind, type PaymentNever,
} from "../../src/lib/money-policy";
import { codeChangeNotPayment, moneyOrder, spendOrder } from "../jarvis-execution/spoken-money";
import { formatMoney, spokenMoney } from "../../src/lib/desk-money";
import { neverLine } from "./policy";

export type DeskKind = PaymentKind | "payment";
export type DeskRequest = {
  kind: DeskKind;
  /** The plain word for the confirm card: "Bill", "Invoice", "Purchase", "Renewal", "Donation", "Zakat"… */
  what: string;
  /** Who he named, or null (the page says who is paid). */
  payee: string | null;
  /** The exact amount he named ("120.00"), or null. */
  amount: string | null;
  /** The currency he named explicitly (A$, US$, AUD, USD…), or null when he said "dollars" or "$". */
  currency: string | null;
  /** A site he named, or a known biller's site: its registrable domain, or null. */
  host: string | null;
  url: string | null;
  /** "pay this", "pay it", "press pay now": the page already in front of him. */
  onThisPage: boolean;
  /** No payee, no site, no amount and not "this": nothing says what to pay. */
  vague: boolean;
  /** A category he named instead of a payee ("the phone bill", "my energy bill"). */
  hint: string | null;
  /** His words, clipped. */
  text: string;
};
export type DeskParse =
  | { ok: true; request: DeskRequest }
  | { ok: false; never: PaymentNever; said: string }
  | { ok: false; ask: string; said: string };

export type DeskConfig = { billers?: Record<string, string>; bank?: string };

const tidy = (text: string) => String(text ?? "").normalize("NFKC").replace(/[‘’`´]/g, "'").replace(/\s+/g, " ").trim();

// --- known billers (his own list adds to this: .operator-data/desk-payments/config.json) --------------------------------
/** Alias (regex source) → the biller's label and site. Only well-known Australian billers and his own services. */
export const DEFAULT_BILLERS: ReadonlyArray<{ alias: string; label: string; host: string }> = [
  { alias: "origin(?:\\s+energy)?", label: "Origin Energy", host: "originenergy.com.au" },
  { alias: "agl", label: "AGL", host: "agl.com.au" },
  { alias: "energy\\s?australia", label: "EnergyAustralia", host: "energyaustralia.com.au" },
  { alias: "telstra", label: "Telstra", host: "telstra.com.au" },
  { alias: "optus", label: "Optus", host: "optus.com.au" },
  { alias: "vodafone", label: "Vodafone", host: "vodafone.com.au" },
  { alias: "amaysim", label: "amaysim", host: "amaysim.com.au" },
  { alias: "aussie\\s+broadband", label: "Aussie Broadband", host: "aussiebroadband.com.au" },
  { alias: "linkt", label: "Linkt", host: "linkt.com.au" },
  { alias: "service\\s+nsw", label: "Service NSW", host: "service.nsw.gov.au" },
  { alias: "sydney\\s+water", label: "Sydney Water", host: "sydneywater.com.au" },
  { alias: "canva", label: "Canva", host: "canva.com" },
  { alias: "vercel", label: "Vercel", host: "vercel.com" },
  { alias: "github", label: "GitHub", host: "github.com" },
  { alias: "islamic\\s+relief(?:\\s+australia)?", label: "Islamic Relief Australia", host: "islamic-relief.org.au" },
  { alias: "launch\\s?good", label: "LaunchGood", host: "launchgood.com" },
];
const CATEGORY = /^(?:phone|mobile|energy|electricity|power|gas|water|internet|broadband|nbn|council|rates|rent|tax|insurance|car|home|house|credit\s+card|card|toll|tolls|utility|utilities|mortgage|health|rego|registration|domain|hosting|subscription|electric|bills?|invoices?|fines?|balance|account|dental|super|debt|loan|zakat|zakah|zakaat|sadaqah|sadaqa|sadqa|charity|donation|donations|fitrah|fitra)$/i;
const PRONOUN = /^(?:this|it|that|the|my|our|a|an|now|him|her|them|me|us|again|today|tomorrow|please|then|also|jarvis|one|some|button|pay|order|payment|half|grand)$/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function billerIn(text: string, config: DeskConfig): { label: string; host: string } | null {
  const own = Object.entries(config.billers ?? {});
  const all = [...own.map(([alias, host]) => ({ alias: escapeRe(alias), label: alias.replace(/\b\w/g, (c) => c.toUpperCase()), host })), ...DEFAULT_BILLERS];
  let best: { label: string; host: string; len: number } | null = null;
  for (const b of all) {
    const m = new RegExp(`(?<![\\w-])(?:${b.alias})(?![\\w-])`, "i").exec(text);
    if (m && (!best || m[0].length > best.len)) best = { label: b.label, host: b.host, len: m[0].length };
  }
  return best ? { label: best.label, host: best.host } : null;
}

// --- amounts --------------------------------------------------------------------------------------------------------
const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** "one hundred and twenty" → 120; "two thousand five hundred" → 2500; null when it isn't a plain cardinal. */
export function wordsToNumber(words: string): number | null {
  const parts = words.toLowerCase().replace(/-/g, " ").split(/\s+/).filter((w) => w && w !== "and");
  if (!parts.length) return null;
  let total = 0, current = 0, seen = false;
  for (const w of parts) {
    if (w in UNITS) current += UNITS[w];
    else if (w in TENS) current += TENS[w];
    else if (w === "hundred") current = (current || 1) * 100;
    else if (w === "thousand" || w === "grand") { total += (current || 1) * 1000; current = 0; }
    else return null;
    seen = true;
  }
  return seen ? total + current : null;
}
const SYMBOL_CURRENCY: Record<string, string> = { a: "AUD", au: "AUD", us: "USD", nz: "NZD", c: "CAD", hk: "HKD", s: "SGD" };
export type NamedAmount = { amount: string; currency: string | null; raw: string };
const num = (s: string) => Number(s.replace(/,/g, ""));
const two = (n: number) => n.toFixed(2);
/** The amounts in his words, distinct, with the currency only when he named one ("A$120", "50 USD", "AUD 20"). Pure. */
export function amountsIn(text: string): NamedAmount[] {
  const t = tidy(text);
  const found = new Map<string, NamedAmount>();
  const add = (value: number | null, currency: string | null, raw: string) => {
    if (value === null || !Number.isFinite(value) || value <= 0) return;
    const key = `${two(value)}|${currency ?? ""}`;
    if (!found.has(key)) found.set(key, { amount: two(value), currency, raw });
  };
  for (const m of t.matchAll(/\b(a|au|us|nz|c|hk|s)\$\s?(\d[\d,]*(?:\.\d{1,2})?)(\s?k\b)?/gi)) add(num(m[2]) * (m[3] ? 1000 : 1), SYMBOL_CURRENCY[m[1].toLowerCase()], m[0]);
  for (const m of t.matchAll(/(?<![\w$])\$\s?(\d[\d,]*(?:\.\d{1,2})?)(\s?k\b)?/gi)) add(num(m[1]) * (m[2] ? 1000 : 1), null, m[0]);
  for (const m of t.matchAll(/(€|£)\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) add(num(m[2]), m[1] === "€" ? "EUR" : "GBP", m[0]);
  for (const m of t.matchAll(/\b(aud|usd|nzd|gbp|eur)\s?(\d[\d,]*(?:\.\d{1,2})?)/gi)) add(num(m[2]), m[1].toUpperCase(), m[0]);
  for (const m of t.matchAll(/(?<![\w$.])(\d[\d,]*(?:\.\d{1,2})?)\s*(dollars?|bucks|aud|usd|nzd|gbp|eur)\b/gi)) {
    const unit = m[2].toLowerCase();
    add(num(m[1]), /^(?:dollars?|bucks)$/.test(unit) ? null : unit.toUpperCase(), m[0]);
  }
  // Spoken: "one hundred and twenty dollars", "fifty bucks".
  const WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|and)";
  for (const m of t.matchAll(new RegExp(`\\b((?:${WORD}[\\s-]+)*${WORD})\\s+(dollars?|bucks)\\b`, "gi"))) add(wordsToNumber(m[1]), null, m[0]);
  // Cents and grand: "500 cents" is A$5.00, "5 grand" is 5000 (never read as 500 or 5).
  for (const m of t.matchAll(/(?<![\w$.])(\d[\d,]*(?:\.\d+)?)\s*cents?\b/gi)) add(num(m[1]) / 100, null, m[0]);
  for (const m of t.matchAll(/(?<![\w$.])(\d[\d,]*(?:\.\d+)?)\s*grand\b/gi)) add(num(m[1]) * 1000, null, m[0]);
  // A bare number after a pay verb ("pay Sam 50", "pay 120 to Origin", "pay bianca 1.5k"): only with a verb, never a stray digit,
  // and never a number that already carries its own unit (dollars, cents, a currency code, grand).
  for (const m of t.matchAll(/\b(?:pay|send|give|transfer|wire|flick|tip|donate|shout)\s+(?:[a-z][\w'&.-]*\s+){0,3}?(\d[\d,]*(?:\.\d{1,2})?)(\s?k\b)?(?!\s*(?:%|st\b|nd\b|rd\b|th\b|x\b|:|\/|-|cents?\b|grand\b|dollars?\b|bucks\b|aud\b|usd\b|nzd\b|gbp\b|eur\b))(?![\w.,])/gi)) add(num(m[1]) * (m[2] ? 1000 : 1), null, m[1] + (m[2] ?? ""));
  // "pay the Telstra bill for 89.90", "of 120": a figure after for/of with cents or at least two digits.
  for (const m of t.matchAll(/\b(?:for|of|worth)\s+(\d{2,}[\d,]*(?:\.\d{1,2})?|\d+\.\d{1,2})(?![\w.,]|\s*(?:%|st\b|nd\b|rd\b|th\b|x\b|:|\/|-|months?|years?|days?|weeks?|hours?|minutes?|mins?|people|items|users?))/gi)) add(num(m[1]), null, m[1]);
  return [...found.values()];
}

export { formatMoney, spokenMoney };

// --- what his words order -------------------------------------------------------------------------------------------
const QUESTION_LEAD = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:what|when|why|how|which|who|where|is|are|was|were|does|did|do\s+i|have\s+i|has|should|could\s+you\s+tell)\b/i;
const PRESS_PAY =
  /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:click|press|hit|tap|push|select)\s+(?:on\s+)?(?:the\s+)?(?:pay(?:\s+now|\s+bill|\s+invoice|\s+securely|\s+with\s+card)?|place\s+(?:my\s+|the\s+|your\s+)?order|confirm\s+(?:and\s+pay|payment|order|purchase)|make\s+(?:a\s+|the\s+)?payment|buy\s+now|complete\s+(?:the\s+)?(?:purchase|order|payment)|submit\s+(?:the\s+)?(?:payment|order)|donate(?:\s+now)?|renew(?:\s+now)?|subscribe|check\s?out)\b/i;
const SEND_VERBS = /\b(?:send|give|transfer|wire|flick|chuck|bung|tip|shout|lend)\b/i;
/**
 * A card number in his words is refused when he is paying with it or asking it typed ("pay Sam with card 4111…", "type
 * 4111… into the field"); writing it in a note or memory ("remember that the card is 4111…") is the memory guard's to
 * refuse, in its own words, not a payment.
 */
const CARD_PAYING = /\b(?:pay|paying|paid|buy|purchase|checkout|check\s?out|order|donate|type|enter|fill|put|key\s+in|use|charge)\b/i;
const NOTE_LEAD = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:remember|note|take\s+a\s+note|jot|save|store|record|write\s+down|add\s+to\s+(?:my\s+)?notes)\b/i;
const cardInAPayingOrder = (t: string) => CARD_PAYING.test(t) && !NOTE_LEAD.test(t);
/** Giving to charity in his words ("give sadaqah to the masjid appeal", "send my zakat"), and a paid plan he names ("subscribe to Canva Pro"). */
const GIVING = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:give|send|pay|donate|offer|distribute|make)\b[^.;]{0,40}\b(?:zakat|zakah|zakaat|sadaqah|sadaqa|sadqa|sadaka|fitrah|fitra|fidya|fidyah|kaffarah|qurbani|udhiyah|charity|donations?)\b/i;
const SETTLE = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:settle|clear|pay\s+off|sort\s+out|square\s+away)\b[^.;]{0,50}\b(?:bill|invoice|balance|debt|rates|rego|fine|levy|charge)s?\b/i;
const MAKE_PAYMENT = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:make|do)\s+(?:a\s+|the\s+)?(?:payment|transfer)\b/i;
const PAID_PLAN = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:subscribe\s+to|sign\s+(?:me\s+)?up\s+(?:for|to)|upgrade\s+(?:me\s+)?to|start\s+(?:my\s+|a\s+)?(?:paid\s+)?(?:subscription|plan))\b[^.;]{0,40}\b(?:pro|premium|plus|paid|plan|membership|subscription|canva|vercel|github|adobe|netflix|spotify|chatgpt|claude)\b/i;
const SHOP_ORDER = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?order\s+.{2,80}?\b(?:on|from|at|via|through)\s+(?:the\s+)?(?:uber\s?eats|door\s?dash|menulog|deliveroo|amazon|ebay|kogan|jb\s?hi-?fi|officeworks|bunnings|catch|temu|etsy)\b/i;
/**
 * His words order a payment, or press a pay button. Not a question ("how do I pay a BPAY bill"), a reminder ("remind me
 * to pay"), code work ("fix the checkout bug") or opening a bank ("open my bank"). Pure.
 */
export function deskPayOrder(text: string): boolean {
  const t = tidy(text);
  if (!t || t.length > 600) return false;
  if (QUESTION_LEAD.test(t) && !/\b(?:for me|on my behalf|you (?:to\s+)?pay)\b/i.test(t)) return false;
  if (codeChangeNotPayment(t)) return false;
  // A refund or a chargeback isn't a payment he's making at a pay button: the usual rules have those words.
  if (/\b(?:refund\w*|charge\s?backs?|reverse\s+(?:the|that|this)\s+payment)\b/i.test(t)) return false;
  if (cardNumberIn(t)) return cardInAPayingOrder(t);
  if (PRESS_PAY.test(t) || GIVING.test(t) || PAID_PLAN.test(t) || SHOP_ORDER.test(t) || SETTLE.test(t) || MAKE_PAYMENT.test(t)) return true;
  if (spendOrder(t)) return true;
  // "send Sam $50", "give Mehroz 20 bucks", "flick Bianca 100": a money-moving verb with an amount.
  return SEND_VERBS.test(t) && moneyRefusal(t)?.kind === "money-or-trading" && (MONEY_AMOUNT.test(t) || /\d/.test(t));
}
/**
 * His words order something that is never done, even at the desk: a trade or investment, crypto, a bet, or typing card
 * details. They get the one short line instead of a lecture (or a chat model's guess). A question about them ("what's the
 * bitcoin price") or reading about them is research, and is not this. Pure.
 */
export function deskNeverOrder(text: string): boolean {
  const t = tidy(text);
  if (!t || t.length > 600) return false;
  if (cardNumberIn(t)) return cardInAPayingOrder(t);
  if (!moneyOrder(t)) return false;
  const intent = paymentIntent(t);
  return !!intent && "never" in intent && !!neverLine(intent.never);
}
/** Any of his words this module answers itself: a payment order, or an order that is never done. */
export const deskMoneyOrder = (text: string) => deskPayOrder(text) || deskNeverOrder(text);

export type DeskOpen = { ok: true; host: string; url: string; name: string } | { ok: false; never: PaymentNever; said: string } | null;
const OPEN_LEAD = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:open(?:\s+up)?|go\s+to|visit|launch|take\s+me\s+to|pull\s+up|bring\s+up|head\s+to|log\s?in\s+to|login\s+to|sign\s?in\s+to|log\s+on\s+to)\s+(?:the\s+|my\s+|our\s+)?(.{2,80}?)(?:\s+(?:please|for me|now|website|site|page|app|account|dashboard|login|online|banking))*\s*[.!?]?$/i;
const DOMAIN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\/\S*)?$/i;
/**
 * "open my bank", "open CommBank", "go to paypal.com": at his desk a bank, payment or money-government site simply
 * opens. A broker, exchange or bookie gets the never line. Anything else (a page, a shop, an app) is null: the usual
 * rules have it. `bank` is his own bank's site ("my bank"). Pure.
 */
export function deskOpenOrder(text: string, config: DeskConfig = {}): DeskOpen {
  const t = tidy(text);
  const m = OPEN_LEAD.exec(t);
  if (!m) return null;
  if (deskPayOrder(t)) return null;
  const target = m[1].trim();
  // "open X and do something else" is more than opening X: never opened on its own with the rest silently dropped.
  if (/(?:\s(?:and|then|also|plus)\s|[,;])/i.test(target)) return null;
  const bare = target.replace(/\s+(?:website|site|page|app|account|dashboard|login|online|banking)$/i, "");
  const domain = DOMAIN.exec(bare);
  const host = domain?.[1].toLowerCase().replace(/^www\./, "") ?? null;
  const kind = host ? moneyHostKind(host) : null;
  if (kind === "broker") return { ok: false, never: "trade", said: neverLine("trade")! };
  if (kind === "crypto") return { ok: false, never: "crypto", said: neverLine("crypto")! };
  if (kind === "gambling") return { ok: false, never: "betting", said: neverLine("betting")! };
  if (host && (kind === "bank" || kind === "payment" || kind === "gov")) return { ok: true, host, url: `https://${host}/`, name: host };
  if (host) return null;
  // "my bank" / "my banking": his own bank.
  if (/^(?:bank|banking|internet banking|online banking|netbank|net bank)$/i.test(bare)) {
    const own = (config.bank ?? "nab.com.au").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    return { ok: true, host: own, url: `https://${own}/`, name: own };
  }
  const inst = institutionFor(bare) ?? (/^stripe$/i.test(bare) ? { kind: "payment" as const, host: "dashboard.stripe.com" } : null);
  if (!inst) return null;
  if (inst.kind === "broker") return { ok: false, never: "trade", said: neverLine("trade")! };
  if (inst.kind === "crypto") return { ok: false, never: "crypto", said: neverLine("crypto")! };
  if (inst.kind === "gambling") return { ok: false, never: "betting", said: neverLine("betting")! };
  return { ok: true, host: inst.host, url: `https://${inst.host}/`, name: inst.host };
}

// --- who, how much, where ---------------------------------------------------------------------------------------------
const KIND_WORD: Record<string, string> = {
  bill: "Bill", invoice: "Invoice", purchase: "Purchase", subscription: "Subscription", renewal: "Renewal", donation: "Donation",
  zakat: "Zakat", sadaqah: "Sadaqah", "saved-payee": "Payment", payment: "Payment",
};
const cleanPayee = (raw: string | undefined): string | null => {
  if (!raw) return null;
  let s = raw.trim().replace(/^["'“”]+|["'“”.!?,;]+$/g, "").replace(/'s$/i, "").replace(/\s+/g, " ");
  s = s.replace(/^(?:the|my|our)\s+/i, "");
  let words = s.split(" ").filter(Boolean);
  // "ATO debt", "CommBank credit card": the trailing category words say what kind of payment, not who is paid.
  while (words.length > 1 && CATEGORY.test(words[words.length - 1])) words = words.slice(0, -1);
  while (words.length > 1 && /^(?:credit|debit|loan)$/i.test(words[words.length - 1])) words = words.slice(0, -1);
  // "Bianca half a grand": the amount words after the name aren't part of it.
  while (words.length > 1 && (PRONOUN.test(words[words.length - 1]) || /^(?:half|quarter)$/i.test(words[words.length - 1]))) words = words.slice(0, -1);
  s = words.join(" ");
  if (!words.length || words.length > 5 || s.length > 60) return null;
  if (words.every((w) => PRONOUN.test(w) || CATEGORY.test(w))) return null;
  return s;
};
const AMT_SKIP = "(?:(?:[$€£]|a\\$|au\\$|us\\$)\\s?[\\d,.]+k?(?:\\s*(?:dollars?|bucks|aud|usd))?\\s+|[\\d,.]+k?\\s*(?:dollars?|bucks|aud|usd)\\s+|[\\d,.]+k?\\s+(?=to\\b))?";
const TAIL = "(?=\\s+(?:(?:[$€£]|a\\$|au\\$|us\\$)\\s?\\d|\\d|for\\b|on\\b|from\\b|via\\b|with\\b|using\\b|at\\b|by\\b|before\\b|today\\b|now\\b|tomorrow\\b|out\\s+of\\b)|\\s*[,.;!?]?$)";
const PAYEE_PATTERNS: RegExp[] = [
  /\b(?:pay|settle|renew|clear|sort(?:\s+out)?|pay\s+off)\s+(?:the\s+|my\s+|our\s+)?(.+?)\s+(?:bill|invoice|account|rates|rego|registration|subscription|plan|membership|renewal|domain|fine|levy)\b/i,
  new RegExp(`\\b(?:pay|send|give|transfer|wire|flick|chuck|tip|shout|lend)\\s+${AMT_SKIP}(?:to\\s+)?([a-z][a-z0-9&'.-]*(?:\\s+[a-z][a-z0-9&'.-]*){0,3}?)${TAIL}`, "i"),
  /\b(?:donate|give|contribute|pledge)\s+(?:.{0,30}?\s+)?to\s+(?:the\s+)?(.+?)(?=\s+(?:for|on|via|with|using)\b|[,.;!?]|$)/i,
  /\bto\s+(?:the\s+)?([a-z][\w&'. -]{1,40}?)(?=\s+(?:for|on|via|with|using|at)\b|[,.;!?]|$)/i,
];
const HOST_IN_TEXT = /(?:^|[\s(])((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|net|org|au|io|co|gov|edu|nz|uk|app|info)(?:\.[a-z]{2})?)(?::\d+)?(?:\/\S*)?(?=$|[\s,.;!?)])/i;
const ON_THIS = /\b(?:pay|settle|do|press|click|hit|tap|confirm)\s+(?:this|it|that|the\s+(?:bill|invoice|balance|payment|order)|now)\b|^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?pay(?:\s+now|\s+up)?[.!]?\s*$/i;

const NUMBER_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|and)";
/** "pay Sam fifty dollars" → "pay Sam 50 dollars": spoken amounts become digits once, before anything reads them. */
const spokenDigits = (s: string) =>
  s.replace(new RegExp(`\\b((?:${NUMBER_WORD}[\\s-]+)*${NUMBER_WORD})\\s+(dollars?|bucks)\\b`, "gi"), (m, w: string, u: string) => {
    const n = wordsToNumber(w);
    return n === null ? m : `${n} ${u}`;
  });

/** His words → a request, or the never line, or a one-line question. Pure. */
export function parseDeskRequest(text: string, config: DeskConfig = {}): DeskParse | null {
  const t = spokenDigits(tidy(text).slice(0, 600));
  if (!t) return null;
  const intent = paymentIntent(t);
  if (intent && "never" in intent) {
    const line = neverLine(intent.never);
    if (line) return { ok: false, never: intent.never, said: line };
  }
  // A card number typed into his words is refused even when nothing else says money.
  if (cardNumberIn(t)) return { ok: false, never: "card-details", said: neverLine("card-details")! };
  const amounts = amountsIn(t);
  if (amounts.length > 1) return { ok: false, ask: "amount", said: `Which amount: ${amounts.slice(0, 3).map((a) => spokenMoney(a.amount, a.currency)).join(" or ")}?` };
  const biller = billerIn(t, config);
  const named = HOST_IN_TEXT.exec(t)?.[1]?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "") ?? null;
  const namedHost = named ? registrableDomain(named) : null;
  // A site he named that is a broker, exchange or bookie is refused by kind, like the words are.
  const namedKind = named ? moneyHostKind(named) : null;
  if (namedKind === "broker") return { ok: false, never: "trade", said: neverLine("trade")! };
  if (namedKind === "crypto") return { ok: false, never: "crypto", said: neverLine("crypto")! };
  if (namedKind === "gambling") return { ok: false, never: "betting", said: neverLine("betting")! };
  // A bank, payment app or money-government site he names ("the CommBank credit card", "with PayPal", "my ATO debt") is the site.
  const inst = institutionFor(t);
  const instHost = inst && (inst.kind === "bank" || inst.kind === "payment" || inst.kind === "gov") ? registrableDomain(inst.host) : null;
  const host = namedHost ?? (biller ? registrableDomain(biller.host) : null) ?? instHost;
  let payee: string | null = biller?.label ?? null;
  let hint: string | null = null;
  if (!payee) for (const re of PAYEE_PATTERNS) {
    const p = cleanPayee(re.exec(t)?.[1]);
    if (p && !(named && p.toLowerCase().includes(named))) { payee = p; break; }
  }
  if (!payee) {
    const cat = /\b(phone|mobile|energy|electricity|power|gas|water|internet|broadband|council|rates|rent|insurance|toll|tolls|rego|registration|domain|hosting|credit card|mortgage)\b/i.exec(t)?.[1];
    hint = cat ?? null;
  }
  const onThisPage = ON_THIS.test(t) || PRESS_PAY.test(t);
  const amount = amounts[0] ?? null;
  const kind: DeskKind = intent && "approvable" in intent ? intent.approvable : "payment";
  return {
    ok: true,
    request: {
      kind, what: KIND_WORD[kind] ?? "Payment", payee, amount: amount?.amount ?? null, currency: amount?.currency ?? null,
      host, url: host ? `https://${named && namedHost === host ? named : host}/` : null,
      onThisPage, vague: !payee && !host && !amount && !onThisPage && !hint, hint, text: t,
    },
  };
}

/** Does the page's payee (or its host or title) fit the payee he named? Every meaningful word of his must be there. Pure. */
export function payeeFits(named: string, page: { payee: string; host: string | null; title: string; /** The page has its own "Paying: X" line. */ stated: boolean }): boolean {
  const key = (s: string) => normaliseText(s).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  const hostKey = key((page.host ?? "").replace(/\./g, " "));
  // A payee the page STATES ("Paying: Someone Else") is the only thing compared: a title or a site name that says
  // "Origin Energy" must not vouch for a page that says it pays someone else. Only when the page names no payee line do
  // the title and the site stand in.
  const haystack = page.stated ? ` ${key(page.payee)} ` : ` ${key(`${page.payee} ${page.title}`)} ${hostKey} ${hostKey.replace(/ /g, "")} `;
  const tokens = key(named).split(" ").filter((w) => w.length >= 3 && !/^(?:pty|ltd|inc|the|and|for|australia|australian)$/.test(w));
  if (!tokens.length) return true;
  return tokens.every((w) => haystack.includes(w));
}

// away.payment (28 Sep 2026 owner policy, relayed by the lead): what a money press on screen IS, read from
// the page, so the owner can approve that exact payment with his one-time away code. Pure; no I/O.
//
// - paymentFence: surfaces that are never approvable, whatever code he sends, judged by the PAGE as well as
//   the host (REVIEW-SAFETY-R4 findings 2-3): brokers, exchanges and betting sites, but also any page that
//   shows a ticker, units, an order type, a crypto unit or balance, a lottery draw, a new payee or raw bank
//   details, or a transfer to a person (PayID, Osko, Pay anyone) unless that payee is one he registered.
//   And only on hosts he registered for payments (away config `paymentHosts`): an allowlist, not a denylist.
// - paymentDetails: the merchant/payee, the exact amount and currency (locale-aware: "EUR 1.234,56",
//   "R$ 50,00", "$5k", "A$ 1 234.56"; an ambiguous number or a label that disagrees with the total refuses),
//   the host/URL, the title, the button, the card's last four digits if shown, and a digest binding ALL of
//   it plus the page's text and the control's signature. Any change and it no longer matches.
// - paymentStepRefusal: a screen step's own words (never trading, crypto, betting, a new payee or card details).
//
// Nothing here presses, approves or remembers anything: the away runner asks and binds (runner.ts), and
// screen-hands presses once only when the fresh page's digest equals the approved one (index.ts).
import { exactRegistrableDomain, moneyHostKind, moneySurfaceKind, paymentIntent, registrableDomain } from "../../src/lib/money-policy";
import { PRIVATE_DATA as PRIVATE_DATA_RE, SECRET_BEARING as SECRET_BEARING_RE } from "../../src/lib/control-risk";
import { elementSignature, labelOf, type UiElement } from "./plan";

export type PaymentDetails = {
  /** The site's host (no www), or null for a desktop app. */
  host: string | null;
  url: string | null;
  /** The page title as shown (browser suffix removed). */
  title: string;
  /** Who is paid: a "Pay to"/"Payee"/"Merchant" line on the page, else the merchant in the title, else the site. */
  payee: string;
  /** The exact amount, normalised ("1234.56"), its currency ("AUD", "EUR", or "$" when the page doesn't say), and the text as shown. */
  amount: string;
  currency: string;
  raw: string;
  /** The button (or key) that pays. */
  label: string;
  /** The card's last four digits, when the page shows them ("ending 1234", "•••• 1234"). */
  last4: string | null;
  /** The control's signature (plan.ts elementSignature). */
  element: string;
  /** Binds URL + title + payee + amount + currency + page text + control: any change and it no longer matches. */
  digest: string;
};
/** What he registered in the away config: hosts payments may happen on, and payees already saved at his bank. */
export type PaymentPolicy = { hosts?: readonly string[]; payees?: readonly string[] };

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};
const hostOf = (url: string | null) => {
  try {
    return url ? new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};
const cleanTitle = (title: string) => title.replace(/\s[-–—]\s(?:Google Chrome|Microsoft\s?Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Arc)$/i, "").trim();

// --- page evidence (R4: judge the page, not only the host list) ----------------------------------------
/** A trade: an order type, units or shares, a market, a ticker in brackets, "Buy NVDA". */
const TRADE_PAGE = /\b(?:order\s+type|market\s+order|limit\s+(?:order|price)|stop[- ]loss|brokerage(?:\s+fee)?|shares|number\s+of\s+shares|\d+\s+units|etfs?|stock\s+(?:price|market|exchange|order)|nasdaq|nyse|asx|lse|portfolio|holdings|open\s+positions?|position\s+size|leverage|cfds?|forex|pips?|dividends?)\b/i;
/** A ticker in brackets or after Buy/Sell, case-sensitive ("NVIDIA Corp (NVDA)", "Buy NVDA"), never a product code. */
const TRADE_TICKER = /\((?:(?:NASDAQ|NYSE|ASX|LSE):\s?)?(?!(?:GST|AUD|USD|EUR|GBP|NZD|INC|LTD|PTY|USB|TV|PDF|FAQ|ABN)\))[A-Z]{2,5}\)|\b(?:Buy|Sell|BUY|SELL)\s+(?!(?:USB|TV|SSD|HDMI|LED|PC|GPU|CPU|RAM|DVD|NBN|GST|SIM|VPN|NOW|IT)\b)[A-Z]{2,5}\b/;
/** Crypto: a crypto unit or balance, a chain word, a wallet address or fee. */
const CRYPTO_PAGE = /[₿]|\b(?:btc|eth|usdt|usdc|sol|xlm|xrp|doge|ada|dot|avax|matic|trx|ltc|bch|shib|pepe|bnb|arb|op|sui|crypto)\s+balance\b|\b\d+(?:[.,]\d+)?\s?(?:btc|eth|usdt|usdc|sol|xlm|xrp|doge|ada|avax|matic|trx|ltc|bch|shib|pepe|bnb|sui)\b|\b(?:btc|eth|usdt|usdc|sol)\s?\d|\b(?:stellar|bitcoin|ethereum|solana|dogecoin|ripple|cardano|blockchain|seed\s+phrase|wallet\s+address|network\s+fee|gas\s+fee|on-?chain)\b/i;
/** Betting and lotteries. */
/** Betting and lotteries, including draws, raffles, art unions, prize homes and sweeps (R5 §6: a "draw entry" is a lottery). */
const BET_PAGE = /\b(?:powerball|oz\s*lotto|lotto|lottery|lotteries|keno|raffles?|jackpot|thelotter|scratchies|sweepstakes?|sweeps?|bet\s?slip|odds|same\s+game\s+multi|sportsbook|pokies|casino|wager|draw\s+entr(?:y|ies)|(?:prize|lucky|charity|major|home|car)\s+draws?|enter\s+(?:the|this|our)\s+draw|entries\s+(?:in|into|for)\s+(?:the\s+)?draw|tickets?\s+in\s+the\s+draw|art\s+unions?|prize\s+homes?|tombola|win\s+(?:a|this)\s+(?:home|house|car|prize))\b/i;
/** A new payee or raw bank details (R4: "Save this payee for next time", a BSB and an account number). */
const NEW_PAYEE_PAGE = /\b(?:save\s+(?:this\s+|the\s+)?payee|add\s+(?:to\s+)?(?:my\s+)?payees?|(?:add|new|create)\s+(?:a\s+)?(?:payee|biller|beneficiary|recipient)|payee\s+details|pay\s+(?:someone|anyone)\s+new|new\s+account\s+details|(?:enter|type|add|provide)\s+(?:the\s+|a\s+|their\s+)?(?:bsb|account\s+number|iban|swift(?:\s+code)?|routing\s+number))\b/i;
const BSB_PAIR = /\bbsb\b[\s:#]*\d{3}[\s-]?\d{3}[\s\S]{0,60}\baccount(?:\s+(?:number|no\.?))?\b[\s:#]*\d/i;
/** A transfer to a person: PayID, Osko, Pay anyone/someone, bank transfer, send money. */
const TRANSFER_PAGE = /\b(?:pay\s?id|osko|pay\s+(?:anyone|someone)|bank\s+transfer|transfer\s+(?:money|funds|to)|international\s+transfer|send\s+money|to\s+payid|send\s+to|you\s+send|they\s+(?:get|receive)|recipient\s+gets|pay\s+(?:a\s+)?(?:friend|contact|mate)|friends?\s+(?:and|&)\s+family|split\s+(?:the\s+)?bill|request\s+money|beem\s+it|payment\s+to\s+a\s+person)\b/i;
/**
 * Person-to-person apps (R5 §3): on a payment host that isn't a merchant checkout (PayPal, Beem, Wise, Revolut,
 * Venmo, Cash App…), every payment is to a person, so only a saved payee is approvable, whatever the page says.
 */
const MERCHANT_PROCESSOR = /(?:^|\.)(?:stripe\.com|shopify\.com|myshopify\.com|square\.site|squareup\.com|checkout\.com|adyen\.com|braintreegateway\.com|gumroad\.com|lemonsqueezy\.com|paddle\.com|afterpay\.com|zip\.co|zip\.co\.nz|klarna\.com|payments\.google\.com|pay\.google\.com|latitudepay\.com|openpay\.com\.au|humm\.com\.au|bpay\.com\.au|pin\.net\.au|eway\.com\.au|tyro\.com|windcave\.com|securepay\.com\.au|westpac\.com\.au\/payway)$/i;
/** Payment processors many merchants share: a payee line must say who is paid (R4 finding 6: "to stripe.com"). */
const SHARED_PROCESSOR = /(?:^|\.)(?:stripe\.com|paypal\.com|shopify\.com|myshopify\.com|square\.site|squareup\.com|checkout\.com|adyen\.com|braintreegateway\.com|gumroad\.com|lemonsqueezy\.com|paddle\.com|afterpay\.com|zip\.co|klarna\.com|payments\.google\.com|pay\.google\.com)$/i;

/** Person-to-person apps by name (also caught through the institution table's payment kind). */
const P2P_HOST = /(?:^|\.)(?:paypal\.(?:com|me)|paypal\.com\.au|beem\.com\.au|beemit\.com\.au|wise\.com|transferwise\.com|revolut\.com|venmo\.com|cash\.app|zellepay\.com|monzo\.com|up\.com\.au|n26\.com|skrill\.com|remitly\.com|westernunion\.com|moneygram\.com|worldremit\.com|ofx\.com|xe\.com|paysend\.com|wave\.com|gcash\.com|paytm\.com|phonepe\.com|bkash\.com|nagad\.com\.bd|safaricom\.co\.ke|swish\.nu|vipps\.no|mobilepay\.dk|twint\.ch|bizum\.es|blik\.com|satispay\.com|easypaisa\.com\.pk|jazzcash\.com\.pk|sadapay\.pk|nayapay\.com|splitwise\.com)$/i;
/** A host that is only "payment" because a label says pay ("payments.example.com", "pay.council.nsw.gov.au"): a merchant's own pay page, not an app. */
const GENERIC_PAY_LABEL = /^(?:pay|payments?|billing|checkout|secure|portal|my|online)\./i;
/** The payee line on the page ("Payee: Sam Smith", "Paying: Telstra", "Pay to Bianca Design"), or null. */
const PAYEE_LINE = /\b(?:pay(?:ing)?\s+to|to\s+payid|send(?:ing)?\s+to)\s*:?\s+([^\n|]{2,60})|\b(?:payee|merchant|biller|recipient|paying|beneficiary)(?:\s+(?:name|email|e-?mail|account|mobile|phone|details))?\s*:\s*([^\n|]{2,60})/gi;
function payeeLines(texts: string): string[] {
  const out: string[] = [];
  for (const m of texts.matchAll(PAYEE_LINE)) {
    const v = (m[1] ?? m[2] ?? "").trim().replace(/\s+/g, " ");
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
function payeeLine(texts: string): string | null {
  // "Payee: X", "Paying: X", "Merchant: X" need their colon (a title like "Pay a payee - NetBank" isn't a payee line).
  return payeeLines(texts)[0] ?? null;
}
/** Letters of more than one script (a Cyrillic "М" inside "Mehroz"), or invisible characters: never a match. */
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u, /\p{Script=Cherokee}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u, /\p{Script=Devanagari}/u, /\p{Script=Han}/u, /\p{Script=Hangul}/u, /\p{Script=Thai}/u, /\p{Script=Georgian}/u, /\p{Script=Coptic}/u];
export function mixedScript(name: string): boolean {
  // Zero-width and format characters, Hangul fillers, and a stray Latin combining mark left after NFC.
  if (/[\p{Cf}ᅟᅠㅤﾠ̀-ͯ]/u.test(name.normalize("NFC"))) return true;
  const letters = [...name].filter((c) => /\p{L}/u.test(c));
  const used = SCRIPTS.filter((re) => letters.some((c) => re.test(c)));
  return used.length > 1 || letters.some((c) => !SCRIPTS.some((re) => re.test(c)));
}
/**
 * Is the page's payee one he saved (R5 §4)? Compared RAW (NFC, case and spaces only): no confusable folding,
 * so a Cyrillic "Мehroz Khan" or a full-width "Ｍehroz" never matches "Mehroz Khan"; and a mixed-script or
 * invisible-character name is refused outright. Pure.
 */
export function payeeRegistered(list: readonly string[] | undefined, name: string | null): boolean {
  if (!name || mixedScript(name)) return false;
  const key = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  return (list ?? []).some((p) => !mixedScript(p) && key(p) === key(name));
}
const registered = payeeRegistered;
/**
 * Is this host on his payment list (R5 §5)? Entries count only when they are exact registrable domains
 * (never com.au, vercel.app, github.io, a subdomain, an IP or punycode), and the host's own registrable
 * domain must equal one: "checkout.stripe.com" is covered by "stripe.com"; "evil.vercel.app" by nothing. Pure.
 */
export function hostListed(list: readonly string[] | undefined, host: string | null): boolean {
  const mine = registrableDomain(host);
  return !!mine && (list ?? []).some((h) => exactRegistrableDomain(h) === mine);
}

/**
 * Never approvable, whatever code he sends: the reason, or null. `texts` is the page's visible text (and
 * its field names). `policy`: the hosts and saved payees he registered; without it nothing is approvable. Pure.
 */
export function paymentFence(title: string, url: string | null, texts = "", policy: PaymentPolicy = {}): string | null {
  const never = paymentNever(title, url, texts);
  if (never) return never;
  const kind = moneySurfaceKind({ title, url });
  const all = `${title}\n${texts}`;
  const host = hostOf(url);
  const payees = payeeLines(texts);
  const payee = payees[0] ?? null;
  // First, only on sites he registered for payments (an allowlist: an unlisted broker or bookie is never on it).
  if (!hostListed(policy.hosts, host)) return `${host ?? "That app"} isn't on your list of sites for approved payments (away config "paymentHosts"), so I won't ask. Nothing was pressed.`;
  // Two different payee or recipient lines ("Paying: Telstra" above "Recipient email: someone@…"): nothing exact to approve.
  if (payees.length > 1) return `That page names more than one payee or recipient (${payees.slice(0, 3).join("; ")}), so there's nothing exact for you to approve. Nothing was pressed.`;
  // A transfer to a person, any bank page, or any person-to-person payment app (PayPal, Beem, Wise…, R5 §3):
  // only to a payee he registered as already saved.
  const p2p = P2P_HOST.test(host ?? "") || (moneyHostKind(url ?? "") === "payment" && !MERCHANT_PROCESSOR.test(host ?? "") && !GENERIC_PAY_LABEL.test(host ?? ""));
  if ((TRANSFER_PAGE.test(all) || kind === "bank" || p2p) && !registered(policy.payees, payee))
    return `That's a payment to a person${payee ? ` (${payee})` : ""} who isn't on your saved-payee list. Paying anyone else is never approvable.`;
  if (SHARED_PROCESSOR.test(host ?? "") && !payee) return "That checkout is on a shared payment processor and the page doesn't say who is paid, so there's nothing exact for you to approve.";
  return null;
}

/** The never-approvable part alone (every step of a payment task, before any press): the reason, or null. Pure. */
export function paymentNever(title: string, url: string | null, texts = ""): string | null {
  const kind = moneySurfaceKind({ title, url });
  if (kind === "broker") return "That's a broker or trading screen. Trades and investing orders are never approvable, even with your code.";
  if (kind === "crypto") return "That's a crypto exchange or wallet. Crypto is never approvable, even with your code.";
  if (kind === "gambling") return "That's a betting or gambling site. Bets are never approvable, even with your code.";
  const all = `${title}\n${texts}`;
  // A broker, exchange or bookie NAMED on the page ("Bitaroo digital voucher" in an Amazon cart, R5 probe).
  const named = texts ? moneySurfaceKind({ title: texts.slice(0, 3000), url: null }) : null;
  if (named === "broker") return "That page sells something from a broker or trading platform. Trades are never approvable, even with your code.";
  if (named === "crypto") return "That page sells something from a crypto exchange (a voucher or top-up counts). Crypto is never approvable, even with your code.";
  if (named === "gambling") return "That page sells something from a betting site (a voucher or top-up counts). Bets are never approvable, even with your code.";
  if (BET_PAGE.test(all)) return "That page is a bet or a lottery. Those are never approvable, even with your code.";
  if (CRYPTO_PAGE.test(all)) return "That's a crypto payment or a page paying from crypto. Crypto is never approvable, even with your code.";
  if (TRADE_PAGE.test(all) || TRADE_TICKER.test(all)) return "That page is a share, ETF or other trade. Trades are never approvable, even with your code.";
  if (NEW_PAYEE_PAGE.test(all) || BSB_PAIR.test(all)) return "That's a new payee or raw bank details. Paying someone new is never approvable: only payees already saved in your bank or app.";
  return null;
}

/** A screen step's own words, in payment mode: secrets, trades, crypto, betting, new payees and card details stay refused. Pure. */
export function paymentStepRefusal(goal: string): string | null {
  if (SECRET_BEARING_RE.test(goal) || PRIVATE_DATA_RE.test(goal)) return "That names a secret-bearing file or private data, which I never open, read or type. Nothing was touched.";
  const intent = paymentIntent(goal);
  if (intent && "never" in intent && intent.never !== "bank-transfer") return `That step is never approvable (${intent.never.replace("-", " ")}). Nothing was touched.`;
  return null;
}

// --- amounts: locale-aware (R4 finding 4) ------------------------------------------------------------
const SYMBOL: Record<string, string> = { "A$": "AUD", "AU$": "AUD", "US$": "USD", "NZ$": "NZD", "C$": "CAD", "HK$": "HKD", "S$": "SGD", "R$": "BRL", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW", "₽": "RUB", "₱": "PHP", "₺": "TRY", "₦": "NGN", "₫": "VND", "₴": "UAH", "₪": "ILS", "ZŁ": "PLN", "KR": "SEK" };
const CODES = "AUD|USD|NZD|CAD|GBP|EUR|CHF|JPY|CNY|INR|PKR|SGD|HKD|AED|SAR|BRL|PLN|TRY|IDR|VND|THB|ILS|KRW|RUB|SEK|NOK|DKK|CZK|HUF|PHP|MYR|MXN|ZAR|NGN";
/** A number with its grouping: "1.234,56", "1 234.56", "1,00,000", "12,000", "49.99", "50,00", "5". */
const NUM = "\\d{1,3}(?:[.,\\u00a0\\u202f ']\\d{3})+(?:[.,]\\d{1,2})?|\\d{1,2}(?:,\\d{2})+,\\d{3}(?:\\.\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?|\\d+";
const AMOUNT = new RegExp(
  [
    `((?:A|AU|US|NZ|C|HK|S|R)\\$|\\$|[€£¥₹₩₽₱₺₦₫₴₪])\\s?(${NUM})(\\s?[kKmM](?![a-zA-Z]))?`,
    `\\b(${CODES})\\s?(${NUM})(\\s?[kKmM](?![a-zA-Z]))?`,
    `(${NUM})(\\s?[kKmM](?![a-zA-Z]))?\\s?(${CODES}\\b|€|£|zł|kr\\b|₹|₽|₺|₪|₫)`,
  ].join("|"),
  "gi",
);
/** Currencies written 1,234.56 by default (a lone comma before three digits groups thousands). */
const COMMA_THOUSANDS = new Set(["AUD", "USD", "NZD", "CAD", "GBP", "HKD", "SGD", "JPY", "KRW", "INR", "CNY", "PHP", "MYR", "$"]);
const NO_DECIMALS = new Set(["JPY", "KRW", "VND", "IDR"]);
type Found = { amount: string; currency: string; raw: string } | { ambiguous: string };
/** One number → its value, or null when it can't be read without guessing ("EUR 1.234": 1234 or 1.234?). */
export function parseLocaleNumber(numText: string, currency: string, suffix = ""): number | null {
  let s = numText.replace(/[   ']/g, "");
  if (/^\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, ""); // 1,00,000 (lakh grouping)
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  let value: number;
  if (dots && commas) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    value = Number(s.replace(dec === "." ? /,/g : /\./g, "").replace(",", "."));
  } else if (dots + commas === 0) value = Number(s);
  else {
    const sep = dots ? "." : ",";
    const count = dots || commas;
    const after = s.length - s.lastIndexOf(sep) - 1;
    if (count > 1) value = Number(s.split(sep).join("")); // 1.234.567 / 1,234,567
    else if (after <= 2) value = Number(s.replace(sep, ".")); // 49.99 / 50,00
    else if (after === 3 && (NO_DECIMALS.has(currency) || (sep === "," && COMMA_THOUSANDS.has(currency)))) value = Number(s.replace(sep, ""));
    else return null; // "1.234 EUR", "1,234 €": thousands or decimals? Don't guess.
  }
  if (!Number.isFinite(value)) return null;
  const mult = /k/i.test(suffix) ? 1_000 : /m/i.test(suffix) ? 1_000_000 : 1;
  return value * mult;
}
function amountsIn(line: string, host: string | null): Found[] {
  const out: Found[] = [];
  for (const m of line.matchAll(AMOUNT)) {
    const raw = m[0].trim();
    let currency: string;
    let num: string;
    let suffix: string;
    if (m[1] !== undefined) {
      const sym = m[1].toUpperCase().replace("AU$", "A$");
      currency = sym === "$" ? (host && /\.au$/i.test(host) ? "AUD" : "$") : SYMBOL[sym] ?? sym;
      num = m[2];
      suffix = m[3] ?? "";
    } else if (m[4] !== undefined) {
      currency = m[4].toUpperCase();
      num = m[5];
      suffix = m[6] ?? "";
    } else {
      num = m[7];
      suffix = m[8] ?? "";
      const c = m[9].toUpperCase();
      currency = SYMBOL[c] ?? c;
    }
    const value = parseLocaleNumber(num, currency, suffix);
    out.push(value === null ? { ambiguous: raw } : { amount: value.toFixed(2), currency, raw });
  }
  return out;
}
type Read = { amount: string; currency: string; raw: string };
const distinct = (xs: Read[]) => [...new Map(xs.map((x) => [`${x.currency} ${x.amount}`, x])).values()];

/** The merchant in the title ("Checkout - Monitor Shop" → "Monitor Shop"), skipping generic step words. */
function titleMerchant(title: string) {
  const parts = cleanTitle(title).split(/\s[-|–—:]\s/).map((p) => p.trim()).filter(Boolean);
  const generic = /^(?:checkout|check\s?out|pay(?:ment)?|pay now|secure checkout|order|review|cart|basket|your\s+\w+|step\s+\d+(?:\s+of\s+\d+)?|confirm(?:ation)?|billing|donate|donation|subscribe|plans?|pricing)$/i;
  return parts.find((p) => !generic.test(p)) ?? null;
}

/**
 * The payment this press would make, read off the page. Refuses (ok:false) when the page doesn't show ONE
 * exact amount he can read (two amounts, an ambiguous number, or a button amount that differs from the
 * total): he can't approve a payment whose amount he can't see. Pure.
 */
export function paymentDetails(input: { title: string; url: string | null; texts: string; label: string; element: UiElement | null }): { ok: true; details: PaymentDetails } | { ok: false; said: string } {
  const host = hostOf(input.url);
  const lines = input.texts.split(/\s*\n\s*/).filter(Boolean);
  const read = (ls: string[]) => ls.flatMap((l) => amountsIn(l, host));
  const unclear = (xs: Found[]) => xs.find((x): x is { ambiguous: string } => "ambiguous" in x);
  const known = (xs: Found[]) => distinct(xs.filter((x): x is Read => !("ambiguous" in x)));
  const labelFound = amountsIn(input.label, host);
  const totalFound = read(lines.filter((l) => /\b(?:total|amount\s+due|you\s+pay|to\s+pay|pay\s+now|balance\s+due)\b/i.test(l) && !/\bsub\s?-?total\b/i.test(l)));
  const ambiguous = unclear(labelFound) ?? unclear(totalFound);
  if (ambiguous) return { ok: false, said: `I can't read "${ambiguous.ambiguous}" as one exact amount without guessing, so there's nothing exact for you to approve. Nothing was pressed; this one's yours.` };
  const onLabel = known(labelFound);
  const onTotal = known(totalFound);
  if (onLabel.length && onTotal.length && (onLabel.length !== 1 || onTotal.length !== 1 || onLabel[0].amount !== onTotal[0].amount || onLabel[0].currency !== onTotal[0].currency))
    return { ok: false, said: "The button's amount and the page's total don't agree, so there's nothing exact for you to approve. Nothing was pressed; this one's yours." };
  let found = onLabel.length ? onLabel : onTotal;
  if (!found.length) {
    const others = read(lines.filter((l) => /\b(?:amount|due|balance|pay|charge|price|donat\w*|zakat|sadaqah|renew\w*|subscription|per\s+(?:month|year))\b/i.test(l)));
    const u = unclear(others);
    if (u) return { ok: false, said: `I can't read "${u.ambiguous}" as one exact amount without guessing. Nothing was pressed; this one's yours.` };
    found = known(others);
  }
  if (!found.length) {
    const any = read(lines);
    if (unclear(any)) return { ok: false, said: "An amount on the page can't be read without guessing. Nothing was pressed; this one's yours." };
    found = known(any);
  }
  if (found.length !== 1)
    return { ok: false, said: found.length ? "The page shows more than one amount, so I can't tell you the exact payment to approve. Nothing was pressed; this one's yours." : "I can't see the amount on the page, so there's nothing exact for you to approve. Nothing was pressed; this one's yours." };
  const last4 = input.texts.match(/(?:ending(?:\s+in)?|ends\s+in|•{2,}|\*{2,}|x{3,}|…)\s*(\d{4})\b/i)?.[1] ?? null;
  const title = cleanTitle(input.title);
  const payee = payeeLine(input.texts) ?? titleMerchant(input.title) ?? host ?? "unknown";
  const element = elementSignature(input.element);
  const label = (input.element ? labelOf(input.element) : input.label).slice(0, 60);
  const { amount, currency, raw } = found[0];
  // Every line on the page (the line items too), the full URL (path and query) and the title are bound.
  const pageText = fnv(lines.map((l) => l.replace(/\s+/g, " ").trim()).join("\n"));
  const digest = fnv(`${input.url ?? ""}|${title}|${payee.toLowerCase()}|${amount}|${currency}|${element}|${label.toLowerCase()}|${pageText}`);
  return { ok: true, details: { host, url: input.url ? input.url.slice(0, 300) : null, title, payee, amount, currency, raw, label, last4, element, digest } };
}

/** One line for his phone: 'AUD 123.45 (shown as "A$123.45") to Telstra (telstra.com.au), button "Make payment", card ending 4242'. Pure. */
export function describePayment(d: PaymentDetails) {
  const money = /^[A-Z]{3}$/.test(d.currency) ? `${d.currency} ${d.amount}` : `${d.currency}${d.amount}`;
  return `${money} (shown as "${d.raw}") to ${d.payee}${d.host && d.host !== d.payee ? ` (${d.host})` : ""}, button "${d.label}"${d.last4 ? `, card ending ${d.last4}` : ""}`;
}

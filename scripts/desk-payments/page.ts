// Desk payments: what a page IS, read for a payment. Pure; the service reads the page and the hands press.
//
//   payCandidates   which controls on the page pay (the shared money-button list, minus wallets and non-final steps)
//   analyseDeskPage the payee, exact amount, currency, host and pay button, or why there is nothing exact to confirm
//   diffPayment     what changed between the confirm card and the press (amount, payee, host, control, order lines)
//
// The rules are the away-mode ones (scripts/screen-hands/payment.ts: the never fence, the locale-aware amount reader,
// the payee line), used for a page in front of him at his desk: no registered-host list and a new payee is fine, because
// he sees the confirm card first. Trades, crypto, betting and card details typed by Jarvis are never.
import { moneyButton, registrableDomain } from "../../src/lib/money-policy";
import { hostileName, tidyName } from "../browser-hands";
import { hasPayeeLine, paymentDetails, paymentNever } from "../screen-hands/payment";
import type { DeskPage } from "../j2/agent-browser";
import { NEVER_LINE } from "./policy";

export type PayControl = { ref: string; role: string; name: string; /** Which of the same-named controls (0 = first). */ ordinal: number; sig: string };
export type SnapshotRef = { ref: string; role: string; name: string };

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};
const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};
/** The address without its #fragment. */
const bare = (url: string) => {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url.split("#")[0];
  }
};

// --- which controls pay ---------------------------------------------------------------------------------------------
/** Not the final step: wallets and other methods, the cart, the way to checkout, later, and the money moves that aren't paying a bill. */
const NOT_FINAL =
  /\b(?:add\s+to\s+(?:cart|basket|bag|trolley)|check\s?out|proceed\s+to|continue\s+(?:to|with)|review\s+(?:and|&)\s+pay|express|apple\s*pay|google\s*pay|g\s?pay|pay\s?pal|afterpay|zip\s?(?:pay|money)?|klarna|amazon\s+pay|shop\s*pay|pay\s+later|pay\s+in\s+4|pay\s+with|payments?\s+(?:method|options?|details|settings|history)|bet|wager|swap|trade|stake|mint|withdraw|deposit|refund|sell|invest)\b/i;
const PAYS = /\b(?:pay|order|purchase|donate|give|renew|subscribe|buy|complete|confirm|submit|send|checkout)\b/i;
/** A bare confirm on a review step (a bank's last "Confirm"): a control only when nothing above it is on the page. */
const CONFIRM_LIKE = /^(?:confirm|submit|authori[sz]e|approve|confirm\s+payment|complete|pay)$/i;
const REVIEW_TEXT = /\b(?:review|confirm\s+(?:your\s+)?(?:payment|details|order)|you(?:'re|\s+are)\s+(?:paying|sending)|payment\s+summary|check\s+(?:your\s+)?details|order\s+summary)\b/i;

/** Is this control's name a pay button? Hostile names (bidi, mixed script) never are. Pure. */
export function isPayButtonName(name: string): boolean {
  if (hostileName(name)) return false;
  const n = tidyName(name);
  return !!n && moneyButton(n) && !NOT_FINAL.test(n) && PAYS.test(n);
}

/**
 * The controls that pay, from a snapshot: buttons and links whose name is a pay button; if there are none, a bare
 * "Confirm"/"Submit" on a review step. Each carries a signature (role, name, which of the same-named ones), so the press
 * can find exactly it again. Pure.
 */
export function payCandidates(refs: SnapshotRef[], pageText = ""): PayControl[] {
  const usable = refs.filter((r) => /^(?:button|link|menuitem|submit)$/i.test(r.role));
  const seen = new Map<string, number>();
  const make = (r: SnapshotRef): PayControl => {
    const key = `${r.role.toLowerCase()}|${tidyName(r.name).toLowerCase()}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return { ref: r.ref, role: r.role.toLowerCase(), name: tidyName(r.name), ordinal, sig: `${key}#${ordinal}` };
  };
  const all = usable.map(make);
  const primary = all.filter((c) => isPayButtonName(c.name));
  if (primary.length) return primary;
  if (!REVIEW_TEXT.test(pageText)) return [];
  return all.filter((c) => CONFIRM_LIKE.test(c.name) && !hostileName(c.name));
}

// --- the page's money lines (bound into the confirm) -----------------------------------------------------------------
const MONEY_WORDS = /\b(?:total|sub-?\s?total|amount|due|balance|tip|gratuity|donat\w*|zakat|sadaqah|quantity|qty|plan|per\s+(?:month|year|week)|monthly|yearly|weekly|recurring|auto[- ]?(?:pay|renew)|renew\w*|subscri\w*|shipping|delivery|fee|surcharge|levy|charge|gst|tax|discount|promo|pay(?:ing)?\s+to|payee|recipient|biller|from\s+account|reference)\b/i;
const AMOUNTISH = /(?:[$€£¥₹]|\b(?:aud|usd|nzd|gbp|eur)\b|\b[a-z]{1,2}\$)\s?\d|\d\s?(?:[$€£]|\b(?:aud|usd|nzd|gbp|eur)\b)/i;
/** The lines of the page that carry money or what the order is (an amount, a total, a plan, a tip, a recipient), in order. Pure. */
export function moneyLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || line.length > 240) continue;
    if (AMOUNTISH.test(line) || MONEY_WORDS.test(line)) if (!out.includes(line)) out.push(line);
    if (out.length >= 80) break;
  }
  return out;
}

// --- analysis -------------------------------------------------------------------------------------------------------
/** A line that says what the money keeps costing after today ("Renews at A$499.00/year", "then $9.99 per month"). */
const RECUR = /(?:\/\s?(?:mo|month|yr|year|wk|week)\b|\bper\s+(?:month|year|week|annum)\b|\brenew(?:s|al)?\b|\bannually\b|\bmonthly\b|\byearly\b|\bthen\b|\bafter\s+(?:the\s+|your\s+)?(?:free\s+)?trial\b|\brecurring\b|\bevery\s+(?:month|year|week)\b)/i;
/** The first such line with an amount in it, clipped, or null. Pure. */
export function recurringLine(text: string): string | null {
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line && line.length <= 160 && AMOUNTISH.test(line) && RECUR.test(line)) return line.slice(0, 90);
  }
  return null;
}

/** Pages Jarvis doesn't pay on (gift cards and vouchers, buy-now-pay-later, "your stake"), judged from the lines that carry money. */
const GIFT = /\b(?:gift\s?cards?|e-?gift|prepaid\s+(?:visa|mastercard|card)|store\s+credit|vouchers?)\b/i;
const BNPL = /\b(?:buy\s+now,?\s+pay\s+later|(?:\d+|four|six)\s+(?:(?:fortnightly|weekly|monthly)\s+)?(?:instal+ments?|payments?)\s+of\b|instal+ments?\s+of\b|pay\s+in\s+(?:4|four)\b(?!\s+with))/i;
const STAKE = /\b(?:top\s?up\s+your\s+stake|your\s+stake|stake\s+(?:balance|amount)|place\s+your\s+stake)\b/i;
function unpayablePage(page: DeskPage): string | null {
  if (STAKE.test(`${page.title}\n${page.text}`)) return NEVER_LINE.betting;
  const lines = String(page.text ?? "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const carriesMoney = (l: string) => AMOUNTISH.test(l) || /\b(?:qty|quantity|x\s?\d+|\d+\s?x)\b/i.test(l);
  if (GIFT.test(page.title ?? "") || lines.some((l) => GIFT.test(l) && carriesMoney(l))) return "I don't buy gift cards or vouchers; that one's yours.";
  if (lines.some((l) => BNPL.test(l) && (carriesMoney(l) || /pay\s+later|instal/i.test(l)))) return "I don't pay by instalments or buy-now-pay-later; that one's yours.";
  return null;
}

export type DeskDetails = { recurring: string | null; payee: string; /** The page has its own "Paying: X" line. */ stated: boolean; amount: string; currency: string; raw: string; host: string; url: string; title: string; last4: string | null; label: string };
export type DeskAnalysis =
  | { ok: false; kind: "unreadable" | "never" | "human" | "no-button" | "ambiguous" | "amount"; said: string }
  | { ok: true; details: DeskDetails; control: PayControl; digest: string; lines: string[] };

/** The page's own words about a login, a code or a card still to type: his to do, one line. Pure. */
export function needsHuman(page: DeskPage): string | null {
  const f = page.fields;
  if (f.passwordEmpty) return "It's asking for your password; that's yours to type. Say pay this when you're through.";
  if (f.otpEmpty) return "It wants a code sent to you; type it yourself, then say pay this.";
  if (f.cardEmpty) return "The card details are still empty; type them yourself, then say pay this.";
  if (f.cardFrame) return "The card sits in a secure frame I can't read, so pressing Pay is yours this time.";
  return null;
}

/** paymentNever's away wording ("… never approvable, even with your code") as the one short desk line for that kind. Pure. */
export function neverPageLine(said: string): string {
  if (/crypto/i.test(said)) return NEVER_LINE.crypto;
  if (/bet|gambl|lotter|draw|raffle/i.test(said)) return NEVER_LINE.betting;
  if (/broker|trad|share|etf|invest/i.test(said)) return NEVER_LINE.trade;
  return "I don't do that one.";
}

/** paymentDetails' refusals, in the words of a desk (the away wording ends "this one's yours"). */
function amountSaid(said: string): string {
  if (/two different|more than one amount|shows more than one/i.test(said)) return "That page shows more than one amount, so there's nothing exact to confirm. Get to the final total and say pay this.";
  if (/can't see the amount/i.test(said)) return "I can't see an amount on that page yet. Get to the payment step and say pay this.";
  if (/don't agree/i.test(said)) return "The button's amount and the page's total don't agree, so I haven't set up a payment.";
  return "I can't read one exact amount on that page, so I haven't set up a payment.";
}

/**
 * One page, one pay control, one exact payment. `names` are the control's other names (text, aria-label, title, value,
 * alt) per ref, read by the hands: all of them must be pay names and none hostile. Never guesses: two different pay
 * buttons, a page with no exact amount, a trade, a crypto or betting page, or a form still to fill is not a payment.
 */
export function analyseDeskPage(input: { page: DeskPage; refs: SnapshotRef[]; names: Map<string, string[]> }): DeskAnalysis {
  const { page } = input;
  const title = page.title ?? "";
  const url = page.url ?? "";
  if (!/^https?:\/\//i.test(url)) return { ok: false, kind: "unreadable", said: "I can't read that page as a payment page." };
  const never = paymentNever(title, url, page.text, { allowNewPayee: true });
  if (never) return { ok: false, kind: "never", said: neverPageLine(never) };
  const unpayable = unpayablePage(page);
  if (unpayable) return { ok: false, kind: "never", said: unpayable };
  const human = needsHuman(page);
  if (human) return { ok: false, kind: "human", said: human };
  const candidates = payCandidates(input.refs, page.text);
  if (!candidates.length) return { ok: false, kind: "no-button", said: "I can't see a pay button on that page yet. Get to the payment step and say pay this." };
  // Every name the control carries must be a pay name, and none hostile.
  const usable = candidates.filter((c) => {
    const names = input.names.get(c.ref);
    if (!names) return false;
    if (names.some((n) => hostileName(n))) return false;
    return names.every((n) => !tidyName(n) || isPayButtonName(n) || CONFIRM_LIKE.test(tidyName(n)));
  });
  if (!usable.length) return { ok: false, kind: "unreadable", said: "I couldn't read everything the pay button is labelled, so I haven't set up a payment." };
  const distinct = [...new Set(usable.map((c) => c.name.toLowerCase()))];
  if (distinct.length > 1) return { ok: false, kind: "ambiguous", said: `I see more than one way to pay (${distinct.slice(0, 3).map((n) => `"${n}"`).join(", ")}), so I haven't set up a payment. Say which.` };
  const control = usable[0];
  const read = paymentDetails({ title, url, texts: page.text, label: control.name, element: null });
  if (!read.ok) return { ok: false, kind: "amount", said: amountSaid(read.said) };
  const d = read.details;
  const host = hostOf(url) ?? "";
  const lines = moneyLines(page.text);
  const details: DeskDetails = { recurring: recurringLine(page.text), payee: d.payee, stated: hasPayeeLine(page.text), amount: d.amount, currency: d.currency, raw: d.raw, host, url: bare(url).slice(0, 300), title: d.title, last4: d.last4, label: control.name };
  return { ok: true, details, control, lines, digest: bindDigest(details, control, lines) };
}

/** Binds the address (no #fragment), title, payee, exact amount, currency, control and the page's money lines: any change and it differs. */
export function bindDigest(d: Pick<DeskDetails, "url" | "title" | "payee" | "amount" | "currency">, control: Pick<PayControl, "sig">, lines: string[]): string {
  return fnv(`${d.url}|${d.title}|${d.payee.toLowerCase()}|${d.amount}|${d.currency}|${control.sig}|${fnv(lines.join("\n").toLowerCase())}`);
}

/**
 * What differs between the payment he confirmed and the page a moment before the press, in plain words. Empty when the
 * page still shows the same payment. Pure.
 */
export function diffPayment(
  bound: { host: string; payee: string; amount: string; currency: string; control: PayControl; lines: string[]; targetId: string },
  fresh: DeskAnalysis,
  freshTargetId: string | null,
  money: (amount: string, currency: string) => string,
): string[] {
  if (!fresh.ok) return [fresh.said.replace(/[.]$/, "")];
  const out: string[] = [];
  if (freshTargetId !== bound.targetId) out.push("it's a different tab now");
  if ((registrableDomain(fresh.details.host) ?? fresh.details.host) !== (registrableDomain(bound.host) ?? bound.host)) out.push(`the site is now ${fresh.details.host}, not ${bound.host}`);
  if (fresh.details.amount !== bound.amount || fresh.details.currency !== bound.currency) out.push(`the amount is now ${money(fresh.details.amount, fresh.details.currency)}, not ${money(bound.amount, bound.currency)}`);
  if (fresh.details.payee.toLowerCase() !== bound.payee.toLowerCase()) out.push(`it now pays ${fresh.details.payee}, not ${bound.payee}`);
  if (fresh.control.sig !== bound.control.sig) out.push(`the button is now "${fresh.control.name}", not "${bound.control.name}"`);
  if (!out.length && fresh.lines.join("\n").toLowerCase() !== bound.lines.join("\n").toLowerCase()) out.push("the order lines on the page changed");
  return out;
}

// What may be asked for, how it may be answered, and the money refusal list that runs BEFORE `request`.
//
// V7: routine, reversible actions get NO approval prompt: they aren't in this registry and callers just
// act. Consequential actions (send, delete, publish, merge/deploy, account change, forget of kinds b and c)
// are asked ONCE, kept durably and executed once. An action that isn't registered is never approvable
// (fail closed).
//
// Money (V8): nothing that moves money is approvable EXCEPT `away.payment`, and that only with the away
// one-time code, bound to host, payee, amount, element and task, single use, 10-minute expiry. Trades,
// investing, crypto, betting, new payees and transfers to new accounts, the agent typing card numbers,
// passwords or bank OTPs, and any request that originated from observed content stay refused. Screen,
// voice, lesson and control keep refusing money. There is no in-app amount cap.
import { cardNumberIn, MONEY_AMOUNT, moneyButton, moneyHostKind, moneyLabelKind, moneyRefusal, moneySurfaceKind, normaliseText, textVariants, type InstitutionKind } from "../../src/lib/money-policy";

/**
 * spokenYes: the voice pipeline's own STT event; uiConfirm: the approval card clicked in a human browser
 * session; awayCode: the away one-time code; telegramCode: a one-time code the owner sends back in his
 * Telegram DM (for approvals a PROCESS requested, which a UI confirm can't answer).
 */
export type EvidenceKind = "spokenYes" | "uiConfirm" | "awayCode" | "telegramCode";
/** Where the request came from. Observed content (a page, an email, a file) never requests anything. */
export type RequestOrigin = "principal" | "observed-content";

export type ActionPolicy = {
  /** Evidence that can approve it. */
  evidence: readonly EvidenceKind[];
  /** Longest an approval may stay answerable/usable. */
  maxTtlMs: number;
  /**
   * PRESS surfaces (screen, control, lesson, away) drive a UI, so their args also get the full money
   * screen: naming a bank or broker, a money button, an amount on a label. Every other action is screened
   * for money ACTIONS only (pay, top up, purchase...), so invoices, pricing copy and billing code stay askable.
   */
  screenText: boolean;
};

const MIN = 60_000;
const ACTIONS: Record<string, ActionPolicy> = {
  // Memory (Stage D connector): forget of kinds b (memory) and c (full), and bulk retraction.
  "memory.forget": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 10 * MIN, screenText: false },
  "memory.bulk-retract": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 10 * MIN, screenText: false },
  // Coding harness apply steps (coding-harness-contracts.ts ApprovalAction), plus the generic merge.
  "coding.merge": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 60 * MIN, screenText: false },
  "git.merge.protected": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 60 * MIN, screenText: false },
  "git.push.production": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 60 * MIN, screenText: false },
  deploy: { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 60 * MIN, screenText: false },
  "db.migrate.production": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 60 * MIN, screenText: false },
  "provider.config.change": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 60 * MIN, screenText: false },
  // Execution surfaces (migrated after safety-r3; see docs/APPROVALS-JOBS-MIGRATION.md).
  "screen.press": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 2 * MIN, screenText: true },
  "control.run": { evidence: ["spokenYes"], maxTtlMs: 2 * MIN, screenText: true },
  "lesson.run": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 2 * MIN, screenText: true },
  "away.run": { evidence: ["awayCode"], maxTtlMs: 10 * MIN, screenText: true },
  "away.payment": { evidence: ["awayCode"], maxTtlMs: 10 * MIN, screenText: false },
  // Other consequential actions named in V7.
  "message.send": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 10 * MIN, screenText: false },
  "content.publish": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 10 * MIN, screenText: false },
  // Taking published content back down (a lead preview's public site). The same evidence and lifetime as publishing it
  // (scripts/lead-sites/publish-approval.ts); the one registry line the server role's remote take-down needed.
  "content.unpublish": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 10 * MIN, screenText: false },
  "file.delete": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 10 * MIN, screenText: false },
  "account.change": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 10 * MIN, screenText: false },
  // A trigger or routine job that is drafted/held for the owner to look at before it goes any further (scripts/triggers).
  "trigger.review": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 24 * 60 * MIN, screenText: false },
  // Releasing a job kind quarantined by an unacknowledged stop (owner-visible, asked once).
  "jobs.release-quarantine": { evidence: ["spokenYes", "uiConfirm"], maxTtlMs: 10 * MIN, screenText: false },
};

export const AWAY_PAYMENT_TTL_MS = 10 * MIN;
const ACTION_NAME = /^[a-z][a-z-]*(?:\.[a-z][a-z-]*)*$/;

export function actionPolicy(action: string): ActionPolicy | null {
  return Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
}
/** V7: only registered consequential actions are ever asked about; routine ones proceed with no prompt. */
/**
 * The evidence that can answer THIS request. A request made by a process or agent (a coding job, Hermes,
 * the away runner, a script) can't be answered by a UI confirm: any local program can make the owner's
 * browser send navigation headers, so a PC-local session plus a card isn't proof against it. It needs
 * evidence a local process can't mint: the server-recorded spoken yes, or the owner's Telegram DM code.
 * A UI confirm stays valid only for requests the human made in the UI themselves.
 */
export function allowedEvidence(action: string, requesterIsHuman: boolean): EvidenceKind[] {
  const policy = actionPolicy(action);
  if (!policy) return [];
  if (requesterIsHuman) return [...policy.evidence];
  const kinds = policy.evidence.filter((k) => k !== "uiConfirm");
  if (policy.evidence.includes("uiConfirm")) kinds.push("telegramCode");
  return kinds;
}
export function requiresApproval(action: string): boolean {
  return actionPolicy(action) !== null;
}
export const approvableActions = () => Object.keys(ACTIONS);

// --- the refusal list ------------------------------------------------------------------------------
export type RefusalCode =
  | "unknown-action"
  | "observed-content"
  | "money-not-approvable"
  | "trade"
  | "crypto"
  | "betting"
  | "new-payee"
  | "typed-credentials"
  | "payment-out-of-scope"
  | "args-too-large";
export type Refusal = { code: RefusalCode; reason: string };

/** A money verb in an action NAME ("finance.transfer", "screen.pay", "crypto.swap"). */
const MONEY_ACTION = /(?:^|[.-])(?:pay|pays|payment|payments|payee|transfer|transfers|trade|trading|trades|buy|sell|purchase|checkout|order|crypto|bet|betting|gamble|wager|top-?up|topup|withdraw|deposit|invest|investing|swap|stake|remit|refund|charge|billing|credits?|recharge)(?:[.-]|$)/;
/** Explicit trading, crypto and betting WORDS (the institution table catches the brands). No "options", "bonds" or "coins": those are everyday words in payee names and labels. */
const TRADE = /\b(?:trade|trading|trades|shares?|stocks?|equit(?:y|ies)|etfs?|invest(?:ing|ment|ments)?|brokerage|forex|cfds?|securities|share ?market)\b/i;
const CRYPTO = /\b(?:crypto(?:currency|currencies)?|bitcoin|btc|xbt|eth(?:ereum)?|usdt|usdc|stablecoins?|nfts?|defi|web3|wallet address|seed phrase|blockchain|altcoins?)\b|₿/i;
const BETTING = /\b(?:bet|bets|betting|wager|gambl(?:e|ing)|casino|pokies|poker|lotto|lottery|sportsbook|punt(?:ing)?|keno)\b/i;
const NEW_PAYEE = /\b(?:(?:add|new|create|save|register)\s+(?:a\s+)?(?:payee|biller|recipient|beneficiary|account)|new\s+account|pay\s+anyone|one-?off\s+(?:payee|transfer))\b/i;
/**
 * Changing what the business pays: top-ups (incl. auto top-up / auto-reload / auto-recharge), buying
 * credits, plan or tier upgrades and switches, raising a credit or spend limit, adding a payment method.
 * Never approvable on ANY action (§3.2; OpenRouter auto top-up stays off). Keyed on the ACTION, so the
 * bare topic word ("billing page copy", "feat/stripe-billing", "billing address") is fine.
 */
const BILLING_CHANGE =
  /\b(?:auto ?-?)?(?:top ?-?ups?|topup|recharge|reload(?:s|ing)?(?: (?:balance|credits?|funds))?|refill)\b|\bauto ?-?(?:reload|recharge|renew(?:al)?|pay)\b|\b(?:add|buy|purchase|load) (?:more |extra |some )?(?:credits?|funds|balance|tokens)\b|\b(?:buy|purchase|get) \d[\d,]* (?:credits?|tokens)\b|\bcredits? (?:packs?|purchases?|bundles?)\b|\b(?:upgrade|downgrade|switch|move|change|go|bump)\b[^.;]{0,40}\b(?:plan|tier|subscription|pro|premium|creator|business|enterprise|max|paid)\b|\bplan (?:upgrade|change|switch)\b|\b(?:raise|increase|lift|bump|set|change|remove|uncap)\b[^.;]{0,30}\b(?:credit|spend(?:ing)?|billing|budget|usage) (?:limit|cap|ceiling)s?\b|\b(?:add|update|change|replace|set up) (?:a |the |my |our )?(?:payment method|credit card|debit card|card on file|billing (?:details|info|card|method))\b|\bpay ?-?as ?-?you ?-?go\b|\bpaid (?:tier|plan)\b/i;
/** A money MOVE in free text: a money verb with an amount or credits/funds ("pay $20/mo", "send A$50", "buy 1000 credits"). */
const MONEY_MOVE_VERB = /\b(?:pay(?:s|ing)?|transfer(?:s|ring)?|send|sending|remit|purchase|buy|withdraw|deposit|refund|charge|donate|tip|wager|bet|stake|invest|trade|swap|paypal|revolut|venmo|zelle|osko|payid|bpay)\b/i;
const FUNDS_WORDS = /\b(?:credits?|funds|balance|money|cash)\b/i;
/** Keys of a config/account change that carry money ("autoTopUp", "amountUsd", "plan", "billing"). */
const MONEY_KEY = /\b(?:amount|price|cost|usd|aud|budget|credits?|billing|plan|tier|top ?up|recharge|card|payment|invoice|spend)\b/i;
/** Keys that would carry a secret the agent types: card, CVV, password, OTP, PIN, BSB/account number. */
const CREDENTIAL_KEY = /(?:card|cvv|cvc|csc|password|passcode|passphrase|otp|one-?time|pin|bsb|account-?number|accountnumber|iban|swift|routing|secret|token|typed|typetext|fill)/i;
const LONG_DIGITS = /\d(?:[ .-]?\d){11,}/;
const PAYMENT_CATEGORIES = ["bill", "invoice", "purchase", "subscription", "renewal", "donation", "zakat", "sadaqah", "saved-payee"] as const;
export type PaymentCategory = (typeof PAYMENT_CATEGORIES)[number];
/** Active ISO 4217 currencies. Not XBT/XAU/XAG/XDR/XTS and the like: only real payment currencies. */
const ISO_4217 = new Set(
  (
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP " +
    "CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY " +
    "KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK " +
    "NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT " +
    "TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG"
  ).split(" "),
);
export const isIsoCurrency = (code: unknown) => typeof code === "string" && ISO_4217.has(code);

/** The exact V8 scope an away payment is bound to. Amount in minor units (cents); no cap. */
export type AwayPaymentArgs = {
  taskId: string;
  host: string;
  payee: { id: string; name: string; saved: true };
  amount: { minor: number; currency: string };
  element: { label: string; ref: string };
  category: PaymentCategory;
};

// --- walking the args: every key and every string, no silent cap ------------------------------------
const MAX_DEPTH = 32;
const MAX_NODES = 5_000;
const MAX_STRING = 20_000;
class TooLarge extends Error {}
/** A key as words: "autoTopUp" → "auto Top Up", "amount_usd" → "amount usd". */
const keyWords = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ");
/** Every key (as words) and every string value. Throws past the limits: the caller refuses (fail closed). */
export function argTexts(value: unknown): { keys: string[]; values: string[] } {
  const keys: string[] = [];
  const values: string[] = [];
  let nodes = 0;
  const visit = (v: unknown, depth: number) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new TooLarge();
    if (typeof v === "string") {
      if (v.length > MAX_STRING) throw new TooLarge();
      values.push(v);
    } else if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
    else if (v && typeof v === "object") {
      for (const k of Object.keys(v)) {
        if (k.length > 200) throw new TooLarge();
        keys.push(keyWords(k));
        visit((v as Record<string, unknown>)[k], depth + 1);
      }
    }
  };
  visit(value, 0);
  return { keys, values };
}
const refuse = (code: RefusalCode, reason: string): Refusal => ({ code, reason });
const TOO_LARGE = refuse("args-too-large", "The action's arguments are too large or deep to check, so it isn't approvable.");

function tradeCryptoBet(texts: string[]): Refusal | null {
  for (const raw of texts) {
    const t = normaliseText(raw);
    if (BETTING.test(t)) return refuse("betting", "Betting and gambling are never approvable.");
    if (CRYPTO.test(t)) return refuse("crypto", "Crypto is never approvable.");
    if (TRADE.test(t)) return refuse("trade", "Trades and investing are never approvable.");
  }
  return null;
}

// --- funding destinations: the shared institution table (src/lib/money-policy.ts) ----------------------
const NEVER: Partial<Record<InstitutionKind, RefusalCode>> = { broker: "trade", crypto: "crypto", gambling: "betting" };
const neverRefusal = (kind: InstitutionKind | "money" | null): Refusal | null => {
  const code = kind && kind !== "money" ? NEVER[kind] : undefined;
  return code ? refuse(code, "Brokers, exchanges and betting are never a payment destination, whatever the payee is called.") : null;
};
/**
 * A brand hidden in a compound or look-alike token ("mystake", "binanceaustralia", "sportsbetau"): every
 * substring of 5+ letters is looked up in the shared table. A substring hit counts only when it's a table
 * brand or host (the table's heuristic label words count for whole tokens only), so "investigations" and "stakeholder" stay clean.
 */
/** Everyday words that happen to contain a brand ("mistake" ⊃ "stake"). */
const EVERYDAY_WORDS = new Set(["mistake", "mistakes", "mistaken", "unmistakable"]);
function compoundKind(token: string): InstitutionKind | null {
  const t = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (t.length < 3 || t.length > 80) return null;
  // A token is looked up as a bare label and as the .com/.com.au host it would be (the table's exact hosts: stake.com, kraken.com).
  const asHost = (label: string) => {
    for (const host of [`${label}.invalid`, `${label}.com`, `${label}.com.au`]) {
      const kind = moneyHostKind(host);
      if (kind && NEVER[kind]) return kind;
    }
    return null;
  };
  const whole = asHost(t);
  if (whole) return whole;
  if (EVERYDAY_WORDS.has(t)) return null;
  // A look-alike is a brand plus a short affix ("my", "au", "app", "login", "1x"); longer leftovers are
  // other words ("stakeholder"), so only up to 5 extra characters count.
  for (let len = Math.min(t.length - 1, 24); len >= Math.max(5, t.length - 5); len--)
    for (let i = 0; i + len <= t.length; i++) {
      const sub = t.slice(i, i + len);
      const kind = asHost(sub);
      if (kind && kind !== moneyLabelKind(sub)) return kind;
    }
  return null;
}
/**
 * Words that don't make a payee name "another business": legal and region suffixes, account words,
 * connectives and money words. "Binance Australia", "Sportsbet Pty Ltd", "bpay-coinspot", "Deposit to
 * Binance" are the broker/exchange/bookmaker; "Kraken Rum Co", "Stake Dental", "Neds Barbershop",
 * "Crypto Plumbing" carry an ordinary business word and are NOT refused on the name alone.
 */
const BRAND_QUALIFIERS = new Set(
  ("australia au aus aust nz uk us usa global international intl group holdings pty ltd limited inc llc corp co com net org app apps " +
    "online official account accounts wallet exchange markets market trading trade trader broker brokerage invest investing investment " +
    "bet bets betting sports sport racing casino lotto lottery pokies poker crypto bitcoin btc eth coin coins token tokens nft " +
    "deposit deposits deposited funding fund funds topup top up buy sell purchase payment payments pay bpay payid osko transfer " +
    "to for my the a an of and via from into with login secure www shares share stock stocks etf etfs units cfd cfds fx forex pro plus x")
    .split(" "),
);
/** A token that IS a table brand or host (as label, .com or .com.au), no substring folding. */
function wholeKind(token: string): InstitutionKind | null {
  const t = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (t.length < 3) return null;
  for (const host of [`${t}.invalid`, `${t}.com`, `${t}.com.au`]) {
    const kind = moneyHostKind(host);
    if (kind && NEVER[kind]) return kind;
  }
  return null;
}
const NEVER_KIND = (k: InstitutionKind | "money" | null): InstitutionKind | null => (k && k !== "money" && NEVER[k] ? k : null);
/** A run of consecutive name tokens that IS a broker/exchange/bookmaker brand ("sportsbet", "coin spot", "interactive brokers"), or null. */
function runKind(run: string[]): InstitutionKind | null {
  if (run.length === 1) {
    const t = run[0];
    // The shared table's names (Pepperstone, IC Markets...) and hosts/brands, with look-alike folding.
    return NEVER_KIND(moneySurfaceKind({ title: t })) ?? compoundKind(t);
  }
  const spaced = run.join(" ");
  const joined = run.join("");
  const bySpaced = NEVER_KIND(moneySurfaceKind({ title: spaced }));
  // A multi-word run counts only if it needs every word ("sportsbet rewards" is "sportsbet" + "rewards").
  if (bySpaced && run.every((_, i) => !NEVER_KIND(moneySurfaceKind({ title: run.filter((__, j) => j !== i).join(" ") })))) return bySpaced;
  const byJoined = NEVER_KIND(moneySurfaceKind({ title: joined }));
  if (byJoined) return byJoined;
  // A joined token that is a table host, but not one the heuristic label words would call money anyway.
  return moneyLabelKind(joined) === null ? wholeKind(joined) : null;
}
/**
 * What a payee name, id or button label says about where the money goes (broker/crypto/gambling), or null.
 * The name must be ENTIRELY institution: every token covered by a brand run or a qualifier ("Binance
 * Australia", "Sportsbet Pty Ltd", "Coin-Spot", "IC Markets", "bpay-sportsbet"). One ordinary word ("Kraken
 * Rum Co", "Stake Dental", "Coinstar Laundromat") makes it another business, so it isn't refused on the name.
 */
export function fundingKind(text: string): InstitutionKind | null {
  // Every reading the shared policy makes of it (leet "Sp0rtsbet", spaced letters, full-width...).
  for (const variant of textVariants(text)) {
    const kind = coveredKind(variant);
    if (kind) return kind;
  }
  return null;
}
function coveredKind(text: string): InstitutionKind | null {
  const tokens = normaliseText(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12);
  if (!tokens.length) return null;
  // best[i]: the kind found covering tokens[0..i), or "" when covered by qualifiers only, or undefined.
  const best: (InstitutionKind | "" | undefined)[] = [""];
  for (let i = 1; i <= tokens.length; i++) {
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const before = best[j];
      if (before === undefined) continue;
      const run = tokens.slice(j, i);
      if (run.length === 1 && (BRAND_QUALIFIERS.has(run[0]) || /^\d+$/.test(run[0]))) {
        if (best[i] === undefined) best[i] = before;
        continue;
      }
      const kind = runKind(run);
      if (kind) best[i] = before || kind;
      if (best[i]) break;
    }
  }
  return best[tokens.length] || null;
}
/** The host's kind from the shared table (listed hosts, subdomains, punycode look-alikes), plus compound labels. */
export function fundingHostKind(host: string): InstitutionKind | null {
  const kind = moneyHostKind(host);
  if (kind && NEVER[kind]) return kind;
  // A host label that IS a listed institution's name (pepperstone.com, icmarkets.com.au).
  const hostLabels = host.toLowerCase().split(".");
  for (const label of hostLabels.slice(0, Math.max(1, hostLabels.length - 1))) {
    const named = NEVER_KIND(moneySurfaceKind({ title: label })) ?? NEVER_KIND(moneySurfaceKind({ title: label.replace(/-/g, " ") }));
    if (named) return named;
  }
  const labels = host.toLowerCase().split(".");
  for (const label of labels.slice(0, Math.max(1, labels.length - 1))) {
    for (const part of [label, ...label.split("-")]) {
      const k = compoundKind(part);
      if (k) return k;
    }
  }
  return null;
}

/** Validate the V8 away-payment scope. Returns the refusal, or null when it is in scope. */
function awayPaymentRefusal(args: unknown): Refusal | null {
  const a = args as Partial<AwayPaymentArgs> | null;
  if (!a || typeof a !== "object" || Array.isArray(a)) return refuse("payment-out-of-scope", "A payment needs its host, payee, amount, element and task.");
  let texts: { keys: string[]; values: string[] };
  try {
    texts = argTexts(a);
  } catch {
    return TOO_LARGE;
  }
  const typed = refuse("typed-credentials", "Card numbers, passwords, bank codes and account numbers are never typed or approved.");
  // The agent never types card numbers, passwords or bank OTPs, and never carries them in an approval.
  if (texts.keys.some((k) => CREDENTIAL_KEY.test(k.replace(/\s+/g, "")))) return typed;
  // The saved payee's own reference (a BPAY biller code or CRN) may be long digits; nothing else may, and never a card.
  const payeeId = typeof a.payee?.id === "string" ? a.payee.id : null;
  let skippedId = false;
  for (const value of texts.values) {
    const n = normaliseText(value);
    if (cardNumberIn(n) || cardNumberIn(n.replace(/[.]/g, " "))) return typed;
    if (!skippedId && value === payeeId) {
      skippedId = true;
      continue;
    }
    if (LONG_DIGITS.test(n)) return typed;
  }
  const allowed = new Set(["taskId", "host", "payee", "amount", "element", "category"]);
  if (Object.keys(a).some((k) => !allowed.has(k))) return refuse("payment-out-of-scope", "A payment approval carries only its bound fields.");
  if (!a.payee || typeof a.payee !== "object") return refuse("payment-out-of-scope", "A payment needs a saved payee.");
  // Trading/crypto/betting WORDS anywhere except the payee's own name; in the name they count only when
  // the name is nothing but institution and money words ("Bitcoin Deposit", not "Crypto Plumbing").
  const payeeName = typeof a.payee.name === "string" ? a.payee.name : "";
  const words = tradeCryptoBet(texts.values.filter((v) => v !== payeeName));
  if (words) return words;
  const nameWords = tradeCryptoBet([payeeName]);
  if (nameWords) {
    const tokens = normaliseText(payeeName).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (tokens.every((t) => BRAND_QUALIFIERS.has(t) || /^\d+$/.test(t) || !!tradeCryptoBet([t]) || !!compoundKind(t))) return nameWords;
  }
  if (a.payee.saved !== true || (a.payee as { new?: unknown }).new === true)
    return refuse("new-payee", "Only already-saved payees can be paid; adding a payee or paying a new account is refused.");
  if (texts.values.some((s) => NEW_PAYEE.test(normaliseText(s)))) return refuse("new-payee", "Adding a payee or paying a new account is refused.");
  if (Object.keys(a.payee).some((k) => !["id", "name", "saved"].includes(k))) return refuse("payment-out-of-scope", "A payment approval carries only its bound fields.");
  if (typeof a.payee.id !== "string" || !/^[\w:.-]{1,64}$/.test(a.payee.id) || typeof a.payee.name !== "string" || !a.payee.name.trim() || a.payee.name.length > 120)
    return refuse("payment-out-of-scope", "The payee must be identified by its saved id and name.");
  if (typeof a.host !== "string" || !/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(a.host))
    return refuse("payment-out-of-scope", "A payment is bound to the exact host it happens on.");
  // An internationalised (punycode) host can imitate any brand within an edit or two ("xn--sportsbt-4ya"
  // is "sportsàbt"); Australian billers and banks don't use them, so an away payment never goes to one.
  if (/(?:^|\.)xn--/i.test(a.host)) return refuse("payment-out-of-scope", "Payments never go to an internationalised (look-alike) domain.");
  const el = a.element;
  if (!el || typeof el.label !== "string" || !el.label.trim() || el.label.length > 80 || typeof el.ref !== "string" || !el.ref || el.ref.length > 200)
    return refuse("payment-out-of-scope", "A payment is bound to the exact button it presses.");
  // Where the money goes: the shared institution table over the host, the payee name and id, and the button.
  const dest =
    neverRefusal(fundingHostKind(a.host)) ?? neverRefusal(fundingKind(a.payee.name)) ?? neverRefusal(fundingKind(a.payee.id)) ?? neverRefusal(fundingKind(el.label));
  if (dest) return dest;
  const amount = a.amount;
  if (!amount || typeof amount !== "object" || !Number.isSafeInteger(amount.minor) || amount.minor <= 0)
    return refuse("payment-out-of-scope", "A payment is bound to an exact amount in minor units.");
  if (!isIsoCurrency(amount.currency)) {
    if (typeof amount.currency === "string" && CRYPTO.test(amount.currency)) return refuse("crypto", "Crypto is never approvable.");
    return refuse("payment-out-of-scope", "A payment is in a real ISO 4217 currency.");
  }
  if (typeof a.taskId !== "string" || !/^[\w:-]{1,64}$/.test(a.taskId)) return refuse("payment-out-of-scope", "A payment is bound to its away task.");
  if (!PAYMENT_CATEGORIES.includes(a.category as PaymentCategory))
    return refuse("payment-out-of-scope", "Only bills, invoices, purchases, subscriptions, renewals, donations, zakat, sadaqah and saved-payee payments are approvable.");
  return null;
}

/**
 * provider.config.change is bound to ONE allowlisted setting: `{ provider, setting, value }`. Free-text
 * changes, billing, plans, credits, limits, auto top-up/reload and payment details can't be expressed.
 */
export const PROVIDER_SETTINGS = ["model", "fallbackModel", "enabled", "timeoutMs", "maxOutputTokens", "temperature", "region", "priority", "retries"] as const;
function providerConfigRefusal(args: unknown): Refusal | null {
  const a = args as Record<string, unknown> | null;
  const shape = refuse("money-not-approvable", "A provider change is one allowlisted setting (model, fallback model, on/off, timeout, output tokens, temperature, region, priority, retries); billing, plans, credits, limits and top-ups can't be changed here.");
  if (!a || typeof a !== "object" || Array.isArray(a)) return shape;
  const keys = Object.keys(a).sort().join(",");
  if (keys !== "provider,setting,value") return shape;
  if (typeof a.provider !== "string" || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(a.provider)) return shape;
  if (!PROVIDER_SETTINGS.includes(a.setting as (typeof PROVIDER_SETTINGS)[number])) return shape;
  const v = a.value;
  if (!(typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^[\w./:@+-]{1,120}$/.test(v)))) return shape;
  const words = typeof v === "string" ? v.replace(/[/_.:@+-]+/g, " ") : "";
  if (words && (BILLING_CHANGE.test(words) || MONEY_MOVE_VERB.test(words) || /\b(?:plan|tier|credits?|billing|limit|top ?up|reload|recharge)\b/i.test(words))) return shape;
  return null;
}

/** Keys holding message or page COPY: what is said, not what is done (an invoice email names a price). */
const COPY_KEYS = /^(?:body|text|html|subject|content|copy|message|caption|title|description|summary|excerpt|preview|markdown)$/i;
function copyFree(value: unknown, depth = 0): unknown {
  if (depth > 40 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => copyFree(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!COPY_KEYS.test(k)) out[k] = copyFree(v, depth + 1);
  return out;
}

/**
 * The refusal list, checked BEFORE `approvals.request` creates anything. Pure.
 * null = the request may be recorded (it still needs a decision); otherwise it is refused outright.
 */
export function refuseBeforeRequest(input: { action: string; args: unknown; origin: RequestOrigin }): Refusal | null {
  const { action, args, origin } = input;
  if (typeof action !== "string" || !ACTION_NAME.test(action) || action.length > 60) return refuse("unknown-action", "Unknown action.");
  // Observed content never asks for anything, least of all money (a page or an email isn't the owner).
  if (origin !== "principal") return refuse("observed-content", "A request that came from a page, email or file is never approvable.");
  if (action === "away.payment") return awayPaymentRefusal(args);
  if (MONEY_ACTION.test(action)) {
    const hit = tradeCryptoBet([action.replace(/[.-]/g, " ")]);
    return hit ?? refuse("money-not-approvable", "Money is only approvable as an away-mode payment with the away code.");
  }
  const policy = actionPolicy(action);
  if (!policy) return refuse("unknown-action", "That action isn't approvable (routine actions need no approval; unknown ones are refused).");
  if (action === "provider.config.change") return providerConfigRefusal(args);
  // Every registered action: all keys and values are screened, with no silent cap.
  let texts: { keys: string[]; values: string[] };
  try {
    texts = argTexts(args);
  } catch {
    return TOO_LARGE;
  }
  const all = [...texts.keys, ...texts.values];
  // Changing billing (top-up, credits, plan, limits, payment method) is refused on every action, copy included.
  for (const text of all) if (BILLING_CHANGE.test(normaliseText(text))) return refuse("money-not-approvable", "Top-ups, credit purchases, auto top-up/reload, plan changes, limits and payment methods are never approvable.");
  if (policy.screenText) {
    // PRESS surfaces: naming a bank or broker, a money button or an amount on a label is refused too.
    for (const text of all) {
      const money = moneyRefusal(text);
      if (money || moneyButton(text)) return tradeCryptoBet([text]) ?? refuse("money-not-approvable", "Screen, voice, lesson and control actions never move money.");
    }
    return tradeCryptoBet(all);
  }
  // Everything else: a money ACTION (a money verb with an amount, credits or funds) in the non-copy fields.
  // Message and page copy may name prices and invoices; sending a message moves no money.
  const actionTexts = (() => {
    const t = argTexts(copyFree(args));
    return [...t.keys, ...t.values];
  })();
  for (const text of actionTexts) {
    const n = normaliseText(text).replace(/[/_]+/g, " ");
    if (MONEY_MOVE_VERB.test(n) && (MONEY_AMOUNT.test(n) || FUNDS_WORDS.test(n)))
      return tradeCryptoBet([text]) ?? refuse("money-not-approvable", "Money is only approvable as an away-mode payment with the away code.");
    if (moneyRefusal(text)?.kind === "money-or-trading" && MONEY_MOVE_VERB.test(n))
      return tradeCryptoBet([text]) ?? refuse("money-not-approvable", "Money is only approvable as an away-mode payment with the away code.");
  }
  if (action === "account.change" && texts.keys.some((k) => MONEY_KEY.test(k))) return refuse("money-not-approvable", "Account changes never touch billing, plans, credits or top-ups.");
  return null;
}
